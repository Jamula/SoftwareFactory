import {createHash} from 'node:crypto';
import {types} from 'node:util';
const digest=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const version=v=>typeof v==='string'&&v.length<=32&&/^[0-9]+\.[0-9]+\.[0-9]+$/.test(v);
const own=(v,ks)=>v!==null&&typeof v==='object'&&!types.isProxy(v)&&!Array.isArray(v)&&ks.every(k=>Object.hasOwn(Object.getOwnPropertyDescriptor(v,k)??{},'value'));
const deny=reason=>({shadow:true,reuse:false,skipRequiredChecks:false,reason});
export function lockedBuildCache(e){
 if(!own(e,['repositoryId','trustedSource','complete','os','arch','node','dotnet','aspire','lockDigest','configDigest','toolchainDigest'])||e.repositoryId!==1471342715||e.trustedSource!==true||e.complete!==true)return deny('INPUT_UNKNOWN');
 if(!['linux','win32'].includes(e.os)||!['x64','arm64'].includes(e.arch)||![e.node,e.dotnet,e.aspire].every(version)||![e.lockDigest,e.configDigest,e.toolchainDigest].every(digest))return deny('INVALID_IDENTITY');
 const key=createHash('sha256').update(JSON.stringify([e.repositoryId,e.os,e.arch,e.node,e.dotnet,e.aspire,e.lockDigest,e.configDigest,e.toolchainDigest])).digest('hex');
 return {shadow:true,reuse:false,skipRequiredChecks:false,reason:'CACHE_KEY_ONLY',key:'factory-locked-v1-'+key};
}
