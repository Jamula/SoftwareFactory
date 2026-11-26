import test from 'node:test';
import assert from 'node:assert/strict';
import {lockedBuildCache} from '../../tools/engineering-factory/locked-build-cache.mjs';
const e=()=>({repositoryId:1471342715,trustedSource:true,complete:true,os:'win32',arch:'x64',node:'26.13.1',dotnet:'10.0.404',aspire:'17.0.0',lockDigest:'a'.repeat(64),configDigest:'b'.repeat(64),toolchainDigest:'c'.repeat(64)});
test('exact locked inputs are deterministic and every identity change invalidates the key',()=>{
 const a=lockedBuildCache(e());assert.equal(a.reason,'CACHE_KEY_ONLY');assert.match(a.key,/^factory-locked-v1-[a-f0-9]{64}$/);assert.equal(a.reuse,false);assert.equal(a.skipRequiredChecks,false);assert.deepEqual(a,lockedBuildCache(e()));
 for(const change of [{os:'linux'},{arch:'arm64'},{node:'26.13.2'},{dotnet:'10.0.405'},{aspire:'17.0.1'},{lockDigest:'d'.repeat(64)},{configDigest:'d'.repeat(64)},{toolchainDigest:'d'.repeat(64)}])assert.notEqual(lockedBuildCache({...e(),...change}).key,a.key);
 for(const v of [null,new Proxy(e(),{}),{...e(),repositoryId:1},{...e(),trustedSource:false},{...e(),complete:false}])assert.equal(lockedBuildCache(v).reason,'INPUT_UNKNOWN');
 for(const change of [{os:'other'},{arch:'other'},{node:'latest'},{lockDigest:'bad'}])assert.equal(lockedBuildCache({...e(),...change}).reason,'INVALID_IDENTITY');
});

test('bounds all version metadata before hashing',()=>{
 for(const field of ['node','dotnet','aspire']){
  const invalid=lockedBuildCache({...e(),[field]:'1'.repeat(1000000)+'.0.0'});
  assert.equal(invalid.reason,'INVALID_IDENTITY');assert.equal(Object.hasOwn(invalid,'key'),false);
 }
});
