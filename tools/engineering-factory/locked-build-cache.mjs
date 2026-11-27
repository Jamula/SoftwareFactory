import {createHash} from 'node:crypto';
import {types} from 'node:util';
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=v=>typeof v==='string'&&v.length<=32&&/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v);
const own=(v,ks)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&ks.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const sha256=parts=>createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const deny=reason=>({shadow:true,reuse:false,skipRequiredChecks:false,reason});
export function lockedBuildCache(e){
 if(!own(e,['repositoryId','trustedSource','complete','os','arch','node','dotnet','aspire','lockDigest','configDigest','toolchainDigest'])||e.repositoryId!==1471342715||e.trustedSource!==true||e.complete!==true)return deny('INPUT_UNKNOWN');
 if(!['linux','win32'].includes(e.os)||!['x64','arm64'].includes(e.arch)||![e.node,e.dotnet,e.aspire].every(version)||![e.lockDigest,e.configDigest,e.toolchainDigest].every(digest))return deny('INVALID_IDENTITY');
 const key=sha256([e.repositoryId,e.os,e.arch,e.node,e.dotnet,e.aspire,e.lockDigest,e.configDigest,e.toolchainDigest]);
 return {shadow:true,reuse:false,skipRequiredChecks:false,reason:'CACHE_KEY_ONLY',key:'factory-locked-v1-'+key};
}

const SF_REPOSITORY_ID=1471342715;
const SF_REPOSITORY='Jamula/SoftwareFactory';
const PINNED_NODE='26.13.1';
const PINNED_NPM_CI_FLAGS='--ignore-scripts';
const PINNED_DOTNET='10.0.404';
const PINNED_APPHOST_CONFIGURATION='Release';
const PINNED_ASPIRE='17.0.0';
const PINNED_NUGET_SOURCE='https://api.nuget.org/v3/index.json';
const SUPPORTED_RIDS=new Set(['linux-x64','win-x64']);
const CACHE_TARGETS=new Set(['npmCi','nugetApphost','aspireCli']);
const MAX_LOCKED_CONTENT_CHARS=8_388_608;

const DERIVE_FIELDS=[
 'repositoryId','repository','trustedSource','isFork','complete',
 'rid','node','npmCiFlags','dotnet','apphostConfiguration','aspire',
 'packageJsonDigest','packageLockDigest','apphostDigest','globalJsonDigest'
];
const ENTRY_FIELDS=[
 'target','key','writerRepositoryId','writerRepository','writerTrusted','writerIsFork','writerBranchProtected',
 'rid','node','npmCiFlags','dotnet','apphostConfiguration','aspire',
 'inputDigest','expectedArtifactDigest','observedArtifactDigest','cleanLayout'
];

const cacheBlocked=reason=>({
 shadow:true,
 verified:false,
 candidate:false,
 reuse:false,
 allowCacheWrite:false,
 fullVerificationRequired:true,
 skipRequiredChecks:false,
 reason
});

export function hashLockedContent(content){
 if(typeof content!=='string'||content.length===0||content.length>MAX_LOCKED_CONTENT_CHARS)return null;
 return createHash('sha256').update(content,'utf8').digest('hex');
}

export function deriveCiCacheKeys(input){
 if(!own(input,DERIVE_FIELDS)||input.complete!==true||typeof input.trustedSource!=='boolean'||typeof input.isFork!=='boolean')
  return cacheBlocked('INPUT_UNKNOWN');
 if(input.repositoryId!==SF_REPOSITORY_ID||input.repository!==SF_REPOSITORY||input.trustedSource!==true||input.isFork!==false)
  return cacheBlocked('UNTRUSTED_PROVENANCE');
 if(!SUPPORTED_RIDS.has(input.rid)||input.node!==PINNED_NODE||input.npmCiFlags!==PINNED_NPM_CI_FLAGS||
    input.dotnet!==PINNED_DOTNET||input.apphostConfiguration!==PINNED_APPHOST_CONFIGURATION||
    input.aspire!==PINNED_ASPIRE)
  return cacheBlocked('TOOLCHAIN_OR_OS_DRIFT');
 if(![input.packageJsonDigest,input.packageLockDigest,input.apphostDigest,input.globalJsonDigest].every(digest))
  return cacheBlocked('INVALID_DIGEST');
 const inputDigests={
  npmCi:sha256(['npmCi',input.packageJsonDigest,input.packageLockDigest,PINNED_NPM_CI_FLAGS]),
  nugetApphost:sha256(['nugetApphost',input.apphostDigest,input.globalJsonDigest,PINNED_APPHOST_CONFIGURATION,PINNED_NUGET_SOURCE]),
  aspireCli:sha256(['aspireCli',PINNED_ASPIRE,PINNED_NUGET_SOURCE])
 };
 const keys={
  npmCi:`sf-npm-ci-v1-${input.rid}-node-${PINNED_NODE}-${sha256([SF_REPOSITORY_ID,SF_REPOSITORY,'npmCi',input.rid,PINNED_NODE,PINNED_NPM_CI_FLAGS,input.packageJsonDigest,input.packageLockDigest])}`,
  nugetApphost:`sf-nuget-apphost-v1-${input.rid}-dotnet-${PINNED_DOTNET}-${PINNED_APPHOST_CONFIGURATION.toLowerCase()}-${sha256([SF_REPOSITORY_ID,SF_REPOSITORY,'nugetApphost',input.rid,PINNED_DOTNET,PINNED_APPHOST_CONFIGURATION,PINNED_NUGET_SOURCE,input.apphostDigest,input.globalJsonDigest])}`,
  aspireCli:`sf-aspire-cli-v1-${input.rid}-aspire-${PINNED_ASPIRE}-${sha256([SF_REPOSITORY_ID,SF_REPOSITORY,'aspireCli',input.rid,PINNED_DOTNET,PINNED_ASPIRE,PINNED_NUGET_SOURCE])}`
 };
 return {
  shadow:true,
  reuse:false,
  allowCacheWrite:false,
  fullVerificationRequired:true,
  skipRequiredChecks:false,
  reason:'EXACT_CACHE_KEYS_DERIVED',
  rid:input.rid,
  keys,
  inputDigests
 };
}

export function verifyCiCacheEntry(expectedInput,entry){
 const derived=deriveCiCacheKeys(expectedInput);
 if(derived.reason!=='EXACT_CACHE_KEYS_DERIVED')return derived;
 if(!own(entry,ENTRY_FIELDS)||!CACHE_TARGETS.has(entry.target)||typeof entry.key!=='string'||entry.key.length>200||
    typeof entry.writerTrusted!=='boolean'||typeof entry.writerIsFork!=='boolean'||
    typeof entry.writerBranchProtected!=='boolean'||typeof entry.cleanLayout!=='boolean')
  return cacheBlocked('CACHE_ENTRY_UNKNOWN');
 if(entry.writerRepositoryId!==SF_REPOSITORY_ID||entry.writerRepository!==SF_REPOSITORY||
    entry.writerTrusted!==true||entry.writerIsFork!==false||entry.writerBranchProtected!==true)
  return cacheBlocked('UNTRUSTED_WRITER_PROVENANCE');
 if(entry.rid!==expectedInput.rid||entry.node!==expectedInput.node||entry.npmCiFlags!==expectedInput.npmCiFlags||
    entry.dotnet!==expectedInput.dotnet||entry.apphostConfiguration!==expectedInput.apphostConfiguration||
    entry.aspire!==expectedInput.aspire)
  return cacheBlocked('TOOLCHAIN_OR_OS_DRIFT');
 if(![entry.inputDigest,entry.expectedArtifactDigest,entry.observedArtifactDigest].every(digest)||
    entry.inputDigest!==derived.inputDigests[entry.target])
  return cacheBlocked('DIGEST_MISMATCH');
 if(entry.key!==derived.keys[entry.target]||entry.observedArtifactDigest!==entry.expectedArtifactDigest||entry.cleanLayout!==true)
  return cacheBlocked('CACHE_POISONING_DETECTED');
 return {
  shadow:true,
  verified:true,
  candidate:true,
  reuse:false,
  allowCacheWrite:false,
  fullVerificationRequired:true,
  skipRequiredChecks:false,
  reason:'EXACT_CACHE_ENTRY_VERIFIED',
  target:entry.target,
  rid:expectedInput.rid,
  key:entry.key,
  artifactDigest:entry.observedArtifactDigest
 };
}
