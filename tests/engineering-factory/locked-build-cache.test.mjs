import test from 'node:test';
import assert from 'node:assert/strict';
import {
 deriveCiCacheKeys,
 hashLockedContent,
 lockedBuildCache,
 verifyCiCacheEntry
} from '../../tools/engineering-factory/locked-build-cache.mjs';
const e=()=>({repositoryId:1471342715,trustedSource:true,complete:true,os:'win32',arch:'x64',node:'26.13.1',dotnet:'10.0.404',aspire:'17.0.0',lockDigest:'a'.repeat(64),configDigest:'b'.repeat(64),toolchainDigest:'c'.repeat(64)});
test('exact locked inputs are deterministic and every identity change invalidates the key',()=>{
 const a=lockedBuildCache(e());assert.equal(a.reason,'CACHE_KEY_ONLY');assert.match(a.key,/^factory-locked-v1-[a-f0-9]{64}$/);assert.equal(a.reuse,false);assert.equal(a.skipRequiredChecks,false);assert.deepEqual(a,lockedBuildCache(e()));
 for(const change of [{os:'linux'},{arch:'arm64'},{node:'26.13.2'},{dotnet:'10.0.405'},{aspire:'17.0.1'},{lockDigest:'d'.repeat(64)},{configDigest:'d'.repeat(64)},{toolchainDigest:'d'.repeat(64)}])assert.notEqual(lockedBuildCache({...e(),...change}).key,a.key);
 for(const v of [null,[],{},new Proxy(e(),{}),{...e(),repositoryId:1},{...e(),trustedSource:false},{...e(),complete:false}])assert.equal(lockedBuildCache(v).reason,'INPUT_UNKNOWN');
 for(const change of [{os:'other'},{arch:'other'},{node:'latest'},{lockDigest:'bad'}])assert.equal(lockedBuildCache({...e(),...change}).reason,'INVALID_IDENTITY');
});

test('bounds all version metadata before hashing',()=>{
 for(const field of ['node','dotnet','aspire']){
  const invalid=lockedBuildCache({...e(),[field]:'1'.repeat(1000000)+'.0.0'});
  assert.equal(invalid.reason,'INVALID_IDENTITY');assert.equal(Object.hasOwn(invalid,'key'),false);
 }
});

const ciInput = (overrides = {}) => ({
 repositoryId: 1471342715,
 repository: 'Jamula/SoftwareFactory',
 trustedSource: true,
 isFork: false,
 complete: true,
 rid: 'linux-x64',
 node: '26.13.1',
 npmCiFlags: '--ignore-scripts',
 dotnet: '10.0.404',
 aspire: '17.0.0',
 packageJsonDigest: hashLockedContent('{"name":"softwarefactory","private":true}'),
 packageLockDigest: hashLockedContent('{"name":"softwarefactory","lockfileVersion":3}'),
 apphostDigest: hashLockedContent('#:package Aspire.Hosting.AppHost@17.0.0'),
 globalJsonDigest: hashLockedContent('{"sdk":{"version":"10.0.404","rollForward":"disable"}}'),
 ...overrides
});

test('hashLockedContent hashes bounded UTF-8 text and rejects invalid or oversized content', () => {
 const digest = hashLockedContent('locked-manifest');
 assert.match(digest, /^[a-f0-9]{64}$/);
 assert.equal(digest, hashLockedContent('locked-manifest'));
 assert.notEqual(digest, hashLockedContent('locked-manifest-changed'));
 for (const invalid of [null, undefined, 123, '', 'x'.repeat(8_388_609)]) {
  assert.equal(hashLockedContent(invalid), null);
 }
});

test('deriveCiCacheKeys derives OS-scoped exact-input keys for npm ci, NuGet/AppHost, and Aspire.Cli while keeping full verification mandatory', () => {
 const linux = deriveCiCacheKeys(ciInput({rid: 'linux-x64'}));
 const windows = deriveCiCacheKeys(ciInput({rid: 'win-x64'}));
 assert.equal(linux.reason, 'EXACT_CACHE_KEYS_DERIVED');
 assert.equal(windows.reason, 'EXACT_CACHE_KEYS_DERIVED');
 for (const derived of [linux, windows]) {
  assert.equal(derived.shadow, true);
  assert.equal(derived.reuse, false);
  assert.equal(derived.allowCacheWrite, false);
  assert.equal(derived.fullVerificationRequired, true);
  assert.equal(derived.skipRequiredChecks, false);
 }
 assert.match(linux.keys.npmCi, /^sf-npm-ci-v1-linux-x64-node-26\.13\.1-[a-f0-9]{64}$/);
 assert.match(linux.keys.nugetApphost, /^sf-nuget-apphost-v1-linux-x64-dotnet-10\.0\.404-[a-f0-9]{64}$/);
 assert.match(linux.keys.aspireCli, /^sf-aspire-cli-v1-linux-x64-aspire-17\.0\.0-[a-f0-9]{64}$/);
 assert.match(windows.keys.aspireCli, /^sf-aspire-cli-v1-win-x64-aspire-17\.0\.0-[a-f0-9]{64}$/);
 assert.notEqual(linux.keys.npmCi, windows.keys.npmCi);
 assert.notEqual(linux.keys.nugetApphost, windows.keys.nugetApphost);
 assert.notEqual(linux.keys.aspireCli, windows.keys.aspireCli);

 const manifestChanged = deriveCiCacheKeys(ciInput({packageJsonDigest: '0'.repeat(64)}));
 assert.notEqual(manifestChanged.keys.npmCi, linux.keys.npmCi);
 assert.notEqual(manifestChanged.inputDigests.npmCi, linux.inputDigests.npmCi);
 assert.equal(manifestChanged.keys.nugetApphost, linux.keys.nugetApphost);
 assert.equal(manifestChanged.keys.aspireCli, linux.keys.aspireCli);

 const lockChanged = deriveCiCacheKeys(ciInput({packageLockDigest: '1'.repeat(64)}));
 assert.notEqual(lockChanged.keys.npmCi, linux.keys.npmCi);
 assert.equal(lockChanged.keys.nugetApphost, linux.keys.nugetApphost);
 assert.equal(lockChanged.keys.aspireCli, linux.keys.aspireCli);

 const apphostChanged = deriveCiCacheKeys(ciInput({apphostDigest: '2'.repeat(64)}));
 assert.equal(apphostChanged.keys.npmCi, linux.keys.npmCi);
 assert.notEqual(apphostChanged.keys.nugetApphost, linux.keys.nugetApphost);

 const globalChanged = deriveCiCacheKeys(ciInput({globalJsonDigest: '3'.repeat(64)}));
 assert.notEqual(globalChanged.keys.nugetApphost, linux.keys.nugetApphost);
});

test('deriveCiCacheKeys fails closed on malformed inputs, fork/untrusted provenance, OS/toolchain drift, and bad digests', () => {
 for (const invalid of [
  null, [], {}, new Proxy(ciInput(), {}),
  ciInput({complete: false}),
  ciInput({trustedSource: 'yes'}),
  ciInput({isFork: 'no'})
 ]) {
  const denied = deriveCiCacheKeys(invalid);
  assert.equal(denied.reason, 'INPUT_UNKNOWN');
  assert.equal(denied.fullVerificationRequired, true);
  assert.equal(denied.skipRequiredChecks, false);
 }

 for (const untrusted of [
  ciInput({repositoryId: 999}),
  ciInput({repository: 'other/SoftwareFactory'}),
  ciInput({trustedSource: false}),
  ciInput({isFork: true})
 ]) {
  const denied = deriveCiCacheKeys(untrusted);
  assert.equal(denied.reason, 'UNTRUSTED_PROVENANCE');
  assert.equal(denied.reuse, false);
  assert.equal(denied.fullVerificationRequired, true);
 }

 for (const drifted of [
  ciInput({rid: 'linux-arm64'}),
  ciInput({rid: 'darwin-x64'}),
  ciInput({node: '26.13.0'}),
  ciInput({npmCiFlags: '--omit=dev'}),
  ciInput({npmCiFlags: ''}),
  ciInput({dotnet: '10.0.403'}),
  ciInput({aspire: '17.0.1'})
 ]) {
  const denied = deriveCiCacheKeys(drifted);
  assert.equal(denied.reason, 'TOOLCHAIN_OR_OS_DRIFT');
  assert.equal(denied.fullVerificationRequired, true);
 }

 for (const badDigest of [
  ciInput({packageJsonDigest: 'bad'}),
  ciInput({packageLockDigest: 'bad'}),
  ciInput({apphostDigest: 'A'.repeat(64)}),
  ciInput({globalJsonDigest: null})
 ]) {
  const denied = deriveCiCacheKeys(badDigest);
  assert.equal(denied.reason, 'INVALID_DIGEST');
  assert.equal(denied.fullVerificationRequired, true);
 }
});

test('verifyCiCacheEntry verifies all three CI bottleneck targets across linux-x64 and win-x64 and rejects poisoning, drift, mismatch, and untrusted writers', () => {
 for (const rid of ['linux-x64', 'win-x64']) {
  const expected = ciInput({rid});
  const derived = deriveCiCacheKeys(expected);
  const artifactDigest = 'f'.repeat(64);
  for (const target of ['npmCi', 'nugetApphost', 'aspireCli']) {
   const validEntry = {
    target,
    key: derived.keys[target],
    writerRepositoryId: 1471342715,
    writerRepository: 'Jamula/SoftwareFactory',
    writerTrusted: true,
    writerIsFork: false,
    writerBranchProtected: true,
    rid,
    node: '26.13.1',
    npmCiFlags: '--ignore-scripts',
    dotnet: '10.0.404',
    aspire: '17.0.0',
    inputDigest: derived.inputDigests[target],
    expectedArtifactDigest: artifactDigest,
    observedArtifactDigest: artifactDigest,
    cleanLayout: true
   };
   const verified = verifyCiCacheEntry(expected, validEntry);
   assert.deepEqual(verified, {
    shadow: true,
    verified: true,
    candidate: true,
    reuse: false,
    allowCacheWrite: false,
    fullVerificationRequired: true,
    skipRequiredChecks: false,
    reason: 'EXACT_CACHE_ENTRY_VERIFIED',
    target,
    rid,
    key: derived.keys[target],
    artifactDigest
   });

   for (const badWriter of [
    {...validEntry, writerRepositoryId: 42},
    {...validEntry, writerRepository: 'fork/SoftwareFactory'},
    {...validEntry, writerTrusted: false},
    {...validEntry, writerIsFork: true},
    {...validEntry, writerBranchProtected: false}
   ]) {
    const res = verifyCiCacheEntry(expected, badWriter);
    assert.equal(res.reason, 'UNTRUSTED_WRITER_PROVENANCE');
    assert.equal(res.verified, false);
    assert.equal(res.fullVerificationRequired, true);
   }

   for (const drifted of [
    {...validEntry, rid: rid === 'linux-x64' ? 'win-x64' : 'linux-x64'},
    {...validEntry, node: '26.13.0'},
    {...validEntry, npmCiFlags: '--omit=dev'},
    {...validEntry, dotnet: '10.0.400'},
    {...validEntry, aspire: '16.9.0'}
   ]) {
    assert.equal(verifyCiCacheEntry(expected, drifted).reason, 'TOOLCHAIN_OR_OS_DRIFT');
   }

   for (const mismatched of [
    {...validEntry, inputDigest: 'e'.repeat(64)},
    {...validEntry, inputDigest: 'not-a-digest'},
    {...validEntry, expectedArtifactDigest: 'bad'},
    {...validEntry, observedArtifactDigest: 'bad'}
   ]) {
    assert.equal(verifyCiCacheEntry(expected, mismatched).reason, 'DIGEST_MISMATCH');
   }

   for (const poisoned of [
    {...validEntry, key: 'sf-spoofed-key'},
    {...validEntry, observedArtifactDigest: '0'.repeat(64)},
    {...validEntry, cleanLayout: false}
   ]) {
    const res = verifyCiCacheEntry(expected, poisoned);
    assert.equal(res.reason, 'CACHE_POISONING_DETECTED');
    assert.equal(res.verified, false);
    assert.equal(res.candidate, false);
    assert.equal(res.fullVerificationRequired, true);
    assert.equal(res.skipRequiredChecks, false);
   }
  }
 }

 const expected = ciInput();
 const derived = deriveCiCacheKeys(expected);
 const baseEntry = {
  target: 'npmCi',
  key: derived.keys.npmCi,
  writerRepositoryId: 1471342715,
  writerRepository: 'Jamula/SoftwareFactory',
  writerTrusted: true,
  writerIsFork: false,
  writerBranchProtected: true,
  rid: 'linux-x64',
  node: '26.13.1',
  npmCiFlags: '--ignore-scripts',
  dotnet: '10.0.404',
  aspire: '17.0.0',
  inputDigest: derived.inputDigests.npmCi,
  expectedArtifactDigest: 'f'.repeat(64),
  observedArtifactDigest: 'f'.repeat(64),
  cleanLayout: true
 };
 assert.equal(verifyCiCacheEntry(ciInput({isFork: true}), baseEntry).reason, 'UNTRUSTED_PROVENANCE');
 const staleManifest = verifyCiCacheEntry(ciInput({packageJsonDigest: '0'.repeat(64)}), baseEntry);
 assert.equal(staleManifest.reason, 'DIGEST_MISMATCH');
 assert.equal(staleManifest.candidate, false);
 const omitDevSwitch = verifyCiCacheEntry(ciInput({npmCiFlags: 'omit=dev'}), baseEntry);
 assert.equal(omitDevSwitch.reason, 'TOOLCHAIN_OR_OS_DRIFT');
 assert.equal(omitDevSwitch.candidate, false);
 for (const malformed of [
  null, {}, [], new Proxy(baseEntry, {}),
  {...baseEntry, target: 'unknown'},
  {...baseEntry, key: 123},
  {...baseEntry, key: 'x'.repeat(201)},
  {...baseEntry, writerTrusted: 'true'},
  {...baseEntry, writerIsFork: 0},
  {...baseEntry, writerBranchProtected: null},
  {...baseEntry, cleanLayout: 1}
 ]) {
  assert.equal(verifyCiCacheEntry(expected, malformed).reason, 'CACHE_ENTRY_UNKNOWN');
 }
});
