import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {readIssueIdentity, reconcileIssueTrigger} from '../../tools/engineering-factory/issue-event.mjs';

const workflowSha = 'a'.repeat(40);
const baseEnv = {
 GITHUB_EVENT_NAME: 'issues',
 GITHUB_REPOSITORY_ID: '1471342715',
 GITHUB_WORKFLOW_REF: 'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main',
 GITHUB_REF: 'refs/heads/main',
 GITHUB_REF_PROTECTED: 'true',
 GITHUB_WORKFLOW_SHA: workflowSha,
 GITHUB_SHA: workflowSha,
 FACTORY_CHECKOUT_SHA: workflowSha,
 FACTORY_ISSUE_NUMBER: '42',
 GITHUB_RUN_ID: '123'
};
const issue = {
 number: 42, state: 'open',
 repository_url: 'https://api.github.com/repos/Jamula/SoftwareFactory',
 title: 'untrusted issue text', body: 'never returned'
};
const identity = {reason: 'IDENTITY_ONLY', number: 42, state: 'open'};
const deny = (result, reason) => assert.deepEqual(result, {
 shadow: true, evidenceComplete: false, reconciled: false, reason
});

test('reads only bounded public issue identity and returns fresh state', async () => {
 let calls = 0;
 const result = await readIssueIdentity(42, async (url, options) => {
  calls++;
  assert.equal(url, 'https://api.github.com/repos/Jamula/SoftwareFactory/issues/42');
  assert.equal(options.method, 'GET');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.authorization, undefined);
  return new Response(JSON.stringify(issue));
 });
 assert.deepEqual(result, {shadow:true,evidenceComplete:false,reason:'IDENTITY_ONLY',number:42,state:'open'});
 assert.equal(calls, 1);
 assert.equal((await readIssueIdentity(0, () => assert.fail('unexpected read'))).reason, 'INVALID_ISSUE');
});

test('rejects pull requests, wrong repositories, invalid states and malformed issue identities', async () => {
 for (const change of [
  {pull_request:{}}, {repository_url:'https://api.github.com/repos/other/repo'},
  {state:'unknown'}, {number:43}
 ]) {
  const result = await readIssueIdentity(42, async () => new Response(JSON.stringify({...issue,...change})));
  assert.equal(result.reason, 'IDENTITY_UNKNOWN');
 }
 assert.equal((await readIssueIdentity(42, async () => new Response('null'))).reason, 'IDENTITY_UNKNOWN');
 assert.equal((await readIssueIdentity(42, async () => new Response('invalid'))).reason, 'READ_FAILED');
});

test('fails closed for rate limits, HTTP failures, oversized bodies and transport errors', async () => {
 for (const status of [403,429])
  assert.equal((await readIssueIdentity(42, async () => new Response(null,{status}))).reason,'RATE_OR_PERMISSION_UNKNOWN');
 for (const status of [404,204])
  assert.equal((await readIssueIdentity(42, async () => new Response(null,{status}))).reason,'READ_FAILED');
 assert.equal((await readIssueIdentity(42, async () => new Response('x'.repeat(524289)))).reason,'RESPONSE_LIMIT');
 assert.equal((await readIssueIdentity(42, async () => {throw Error('offline');})).reason,'READ_FAILED');
});

test('reconciles trusted issue events against a fresh issue read and drops text', async () => {
 const times = [100, 145];
 const result = await reconcileIssueTrigger(baseEnv, {
  clock: () => times.shift(),
  readIdentity: async number => {
   assert.equal(number, 42);
   return {...identity, state:'closed'};
  }
 });
 assert.deepEqual(result, {
  shadow:true,evidenceComplete:false,reconciled:true,reason:'ISSUE_IDENTITY_MATCHED',
  repositoryId:1471342715,number:42,state:'closed',workflowSha,runId:'123',observedMs:45
 });
 assert.equal(JSON.stringify(result).includes('untrusted'), false);
});

test('rejects untrusted workflow provenance and invalid event numbers before network reads', async () => {
 let reads = 0;
 const deps = {clock:()=>100,readIdentity:async()=>{reads++;return identity;}};
 for (const change of [
  {GITHUB_EVENT_NAME:'pull_request'}, {GITHUB_REPOSITORY_ID:'1'},
  {GITHUB_WORKFLOW_REF:'untrusted'}, {GITHUB_REF:'refs/heads/other'}, {GITHUB_REF_PROTECTED:'false'},
  {GITHUB_WORKFLOW_SHA:'bad'}, {GITHUB_SHA:'b'.repeat(40)},
  {FACTORY_CHECKOUT_SHA:'c'.repeat(40)}
 ]) deny(await reconcileIssueTrigger({...baseEnv,...change},deps),'TRUST_UNKNOWN');
 for (const value of [undefined,'0','42\n','9007199254740992'])
  deny(await reconcileIssueTrigger({...baseEnv,FACTORY_ISSUE_NUMBER:value},deps),'INVALID_ISSUE');
 deny(await reconcileIssueTrigger({...baseEnv,GITHUB_RUN_ID:'invalid id'},deps),'INVALID_EVENT');
 assert.equal(reads,0);
});

test('rejects stale, failed and incomplete authoritative issue reads', async () => {
 const resolve = (value, clock=()=>100) => reconcileIssueTrigger(baseEnv,{clock,readIdentity:async()=>value});
 deny(await resolve({reason:'RATE_OR_PERMISSION_UNKNOWN'}),'RATE_OR_PERMISSION_UNKNOWN');
 deny(await resolve({reason:'READ_FAILED'}),'READ_FAILED');
 deny(await resolve({reason:'IDENTITY_ONLY'}),'IDENTITY_UNKNOWN');
 deny(await resolve({...identity,number:43}),'IDENTITY_UNKNOWN');
 deny(await resolve({...identity,state:'unknown'}),'IDENTITY_UNKNOWN');
 deny(await reconcileIssueTrigger(baseEnv,{clock:()=>100,readIdentity:()=>{throw Error('offline');}}),'READ_FAILED');
 const times=[100,120101];
 deny(await reconcileIssueTrigger(baseEnv,{clock:()=>times.shift(),readIdentity:async()=>identity}),'STALE_EVENT');
});

test('supports a protected-main manual reconcile with an explicit issue number and custom scope', async () => {
 const result = await reconcileIssueTrigger({...baseEnv,GITHUB_EVENT_NAME:'workflow_dispatch'}, {
  clock:()=>100,readIdentity:async()=>identity
 });
 assert.equal(result.reconciled,true);
 assert.equal(result.reason,'ISSUE_IDENTITY_MATCHED');
 assert.equal(result.number,42);

 assert.equal((await readIssueIdentity(42, () => assert.fail('unexpected'), null)).reason, 'TRUST_UNKNOWN');
 deny(await reconcileIssueTrigger(null, {}), 'TRUST_UNKNOWN');
 deny(await reconcileIssueTrigger(baseEnv, null), 'TRUST_UNKNOWN');
 deny(await reconcileIssueTrigger({...baseEnv, get GITHUB_EVENT_NAME() { throw Error('getter'); }}, {}), 'TRUST_UNKNOWN');
 deny(await reconcileIssueTrigger(baseEnv, {get clock() { throw Error('getter'); }}), 'TRUST_UNKNOWN');

 const scopedEnv = {
  ...baseEnv,
  GITHUB_REPOSITORY_ID: '3030',
  GITHUB_REF: 'refs/heads/trunk',
  GITHUB_WORKFLOW_REF: 'Jamula/Spellbook/.github/workflows/shadow-reconcile.yml@refs/heads/trunk'
 };
 const scopedResult = await reconcileIssueTrigger(scopedEnv, {
  clock: () => 200,
  scope: {repository: 'Jamula/Spellbook', repositoryId: 3030, branch: 'trunk'},
  request: async url => {
   assert.equal(url, 'https://api.github.com/repos/Jamula/Spellbook/issues/42');
   return new Response(JSON.stringify({
    number: 42, state: 'open', repository_url: 'https://api.github.com/repos/Jamula/Spellbook'
   }));
  }
 });
 assert.equal(scopedResult.reconciled, true);
 assert.equal(scopedResult.repositoryId, 3030);
});

test('Linux workflow Bash guard rejects case variants, mismatched repo IDs and unprotected refs before checkout', {skip:process.platform==='win32'},()=>{
 const workflow=readFileSync(new URL('../../.github/workflows/shadow-reconcile.yml',import.meta.url),'utf8');
 const start=workflow.indexOf('        run: |',workflow.indexOf('id: optin'));
 const end=workflow.indexOf('      # Never check out',start);
 assert.ok(start>=0&&end>start);
 const guard=workflow.slice(start,end).split('\n').slice(1).map(line=>line.replace(/^          /,'')).join('\n');
 const dir=mkdtempSync(join(tmpdir(),'issue-optin-'));const output=join(dir,'outputs');
 try{
  const env={...process.env,GITHUB_REPOSITORY:'Jamula/SoftwareFactory',GITHUB_REPOSITORY_ID:'1471342715',GITHUB_REF:'refs/heads/main',GITHUB_REF_PROTECTED:'true',GITHUB_EVENT_NAME:'workflow_dispatch',FACTORY_SHADOW_ENABLED:'true',FACTORY_ISSUE_EVENT_SHADOW_ENABLED:'true',FACTORY_PULL_EVENT_SHADOW_ENABLED:'true',FACTORY_CHECK_EVENT_SHADOW_ENABLED:'true',FACTORY_MAIN_EVENT_SHADOW_ENABLED:'true',FACTORY_ISSUE_NUMBER:'42',FACTORY_WORKFLOW_RUN_ID:'501',GITHUB_OUTPUT:output};
  for(const overrides of [{GITHUB_REF:'refs/heads/Main'},{GITHUB_REF:'refs/heads/other'},{GITHUB_REF_PROTECTED:'false'},{GITHUB_REF_PROTECTED:''},{GITHUB_REPOSITORY:'jamula/SoftwareFactory'},{GITHUB_REPOSITORY_ID:'999'},{FACTORY_SHADOW_ENABLED:'TRUE'},{}]){
   rmSync(output,{force:true});execFileSync('bash',['--noprofile','--norc','-c',guard],{env:{...env,...overrides}});
   const result=readFileSync(output,'utf8');
   if(Object.keys(overrides).length){assert.equal(result,'enabled=false\n');}else{assert.equal(result,'enabled=true\nissue_enabled=true\n');}
  }
  for(const [eventCase,expected] of [
   [{GITHUB_EVENT_NAME:'pull_request_target'},'enabled=true\npull_enabled=true\n'],
   [{GITHUB_EVENT_NAME:'issues'},'enabled=true\nissue_enabled=true\n'],
   [{GITHUB_EVENT_NAME:'workflow_run'},'enabled=true\ncheck_enabled=true\n'],
   [{GITHUB_EVENT_NAME:'workflow_run',FACTORY_CHECK_EVENT_SHADOW_ENABLED:'TRUE'},'enabled=true\n'],
   [{GITHUB_EVENT_NAME:'push'},'enabled=true\nmain_enabled=true\n'],
   [{GITHUB_EVENT_NAME:'push',FACTORY_MAIN_EVENT_SHADOW_ENABLED:'false'},'enabled=true\n']
  ]){
   rmSync(output,{force:true});execFileSync('bash',['--noprofile','--norc','-c',guard],{env:{...env,...eventCase}});
   assert.equal(readFileSync(output,'utf8'),expected);
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});
