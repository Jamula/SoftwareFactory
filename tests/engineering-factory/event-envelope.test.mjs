import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createScopedJournalReader,
  eventEnvelope as normalize,
  readCheckRunIdentity,
  readMainIdentity,
  readPullIdentity,
  readReviewIdentity,
  reconcileCheckTrigger,
  reconcileEventTrigger,
  reconcileMainTrigger,
  reconcilePullTrigger,
  reconcileReviewTrigger,
  resolveTrustedScope
} from '../../tools/engineering-factory/event-envelope.mjs';
import {openEventJournal} from '../../tools/engineering-coordinator/event-journal.mjs';
const trust={repositoryId:1,workflowSha:'a'.repeat(40)};
const e={...trust,deliveryId:'delivery-1',kind:'review',head:'b'.repeat(40),receivedMs:100};
test('valid synthetic event drops untrusted payload',()=>{
 assert.deepEqual(normalize({...e,body:'not an instruction'},trust,101),{shadow:true,accepted:true,reason:'NORMALIZED_ONLY',repositoryId:1,kind:'review',head:e.head,deliveryId:'delivery-1',receivedMs:100});
});
test('reject incomplete and malformed evidence',()=>{
 for(const t of [null,[],Object.create(trust),{...trust,repositoryId:0},{...trust,workflowSha:'bad'}]) assert.equal(normalize(e,t,100).reason,'TRUST_UNKNOWN');
 for(const x of [null,[],Object.create(e),{...e,repositoryId:0},{...e,workflowSha:null},{...e,head:'x'},{...e,deliveryId:1},{...e,deliveryId:'bad id'},{...e,kind:'unknown'},{...e,receivedMs:1.5},{...e,receivedMs:-1}]) assert.equal(normalize(x,trust,100).reason,'INVALID_EVENT');
 for(const x of [{...e,repositoryId:2},{...e,workflowSha:'c'.repeat(40)}]) assert.equal(normalize(x,trust,100).reason,'PROVENANCE_MISMATCH');
 for(const now of [null,99,120101]) assert.equal(normalize(e,trust,now).reason,'STALE_EVENT');
});

test('reject accessor metadata without invoking getters',()=>{
 const bad=()=>{throw Error('getter must not run');};
 assert.equal(normalize({...e,get head(){return bad();}},trust,100).reason,'INVALID_EVENT');
 assert.equal(normalize(e,{...trust,get workflowSha(){return bad();}},100).reason,'TRUST_UNKNOWN');
 let reads=0; const x={...e,get head(){return ++reads===1?e.head:'bad';}};
 assert.equal(normalize(x,trust,100).reason,'INVALID_EVENT');assert.equal(reads,0);
});

test('read-only bounded pull metadata without user content or mutation',async()=>{
 const repo={id:1,full_name:'Jamula/SoftwareFactory'},p={number:2,base:{repo,ref:'main',sha:trust.workflowSha},head:{repo,sha:e.head},state:'open',draft:false,body:'do not trust'};
 let calls=0;const read=async(url,opts)=>{calls++;assert.equal(url,'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/2');assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');return new Response(JSON.stringify(p));};
 assert.deepEqual(await readPullIdentity(2,read),{shadow:true,evidenceComplete:false,reason:'IDENTITY_ONLY',repositoryId:1,number:2,head:e.head,base:trust.workflowSha,state:'open',draft:false});assert.equal((await readPullIdentity(0,read)).reason,'INVALID_PULL');assert.equal(calls,1);
 for(const status of [403,429])assert.equal((await readPullIdentity(2,async()=>new Response(null,{status}))).reason,'RATE_OR_PERMISSION_UNKNOWN');
 for(const status of [404,204])assert.equal((await readPullIdentity(2,async()=>new Response(null,{status}))).reason,'READ_FAILED');
 assert.equal((await readPullIdentity(2,async()=>new Response('x'.repeat(524289)))).reason,'RESPONSE_LIMIT');
 for(const change of [null,{...p,number:3},{...p,base:null},{...p,head:null},{...p,base:{...p.base,ref:'dev'}},{...p,base:{...p.base,sha:'bad'}},{...p,head:{...p.head,sha:'bad'}},{...p,base:{...p.base,repo:{...repo,id:0}}},{...p,head:{...p.head,repo:{...repo,id:2}}},{...p,state:'unknown'},{...p,draft:null}])assert.equal((await readPullIdentity(2,async()=>new Response(JSON.stringify(change)))).reason,'IDENTITY_UNKNOWN');
 assert.equal((await readPullIdentity(2,async()=>new Response('invalid'))).reason,'READ_FAILED');
 assert.equal((await readPullIdentity(2,async()=>{throw Error('offline');})).reason,'READ_FAILED');
});

const actions = {
 GITHUB_EVENT_NAME:'pull_request_target', GITHUB_REPOSITORY_ID:'1471342715',
 GITHUB_WORKFLOW_REF:'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main',
 GITHUB_REF_PROTECTED:'true', GITHUB_WORKFLOW_SHA:trust.workflowSha, GITHUB_SHA:trust.workflowSha,
 FACTORY_CHECKOUT_SHA:trust.workflowSha, FACTORY_PULL_NUMBER:'2', FACTORY_PULL_HEAD:e.head, GITHUB_RUN_ID:'123'
};
const identity = {
 repositoryId:1471342715, number:2, head:e.head, base:trust.workflowSha,
 state:'open', draft:false, reason:'IDENTITY_ONLY'
};
const assertBlocked = (result, reason) => assert.deepEqual(result, {
 shadow:true, evidenceComplete:false, reconciled:false, reason
});

test('reconciles the workflow trigger against a public GET, without replaying PR text', async () => {
 const repo = {id:identity.repositoryId, full_name:'Jamula/SoftwareFactory'};
 const number = identity.number;
 const samples = [100, 120];
 const readIdentity = id => readPullIdentity(id, async (url, options) => {
  assert.equal(url, 'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/2');
  assert.equal(options.method, 'GET');
  assert.equal(options.headers.authorization, undefined);
  return new Response(JSON.stringify({
   number, head:{repo,sha:e.head}, base:{repo,sha:trust.workflowSha,ref:'main'},
   state:'open', draft:false, body:'ignored'
  }));
 });
 const result = await reconcilePullTrigger(actions, {clock:() => samples.shift(),readIdentity});
 assert.deepEqual(result, {
  ...identity, reason:'PULL_IDENTITY_MATCHED', shadow:true, evidenceComplete:false, reconciled:true,
  workflowSha:trust.workflowSha, runId:'123', observedMs:20
 });
});

test('rejects untrusted workflows and invalid event metadata before reading the network', async () => {
 let reads = 0;
 const deps = {clock:() => 100, readIdentity:async () => { reads++; }};
 for (const change of [
  {GITHUB_EVENT_NAME:'pull_request'}, {GITHUB_REPOSITORY_ID:'1'}, {GITHUB_WORKFLOW_REF:'untrusted'},
  {GITHUB_REF_PROTECTED:'false'}, {GITHUB_WORKFLOW_SHA:'bad'}, {GITHUB_SHA:e.head}, {FACTORY_CHECKOUT_SHA:e.head}
 ]) assertBlocked(await reconcilePullTrigger({...actions,...change},deps),'TRUST_UNKNOWN');
 for (const value of [undefined,2,'0','2\n','9007199254740992'])
  assertBlocked(await reconcilePullTrigger({...actions,FACTORY_PULL_NUMBER:value},deps),'INVALID_PULL');
 assertBlocked(await reconcilePullTrigger({...actions,FACTORY_PULL_HEAD:'bad'},deps),'INVALID_EVENT');
 assertBlocked(await reconcilePullTrigger({...actions,GITHUB_RUN_ID:'invalid id'},deps),'INVALID_EVENT');
 assert.equal(reads,0);
});

test('rejects stale reads, shifted heads, rate limits and mismatched PR identities', async () => {
 const reconcile = (value, clock = () => 100) => reconcilePullTrigger(actions,{clock,readIdentity:async () => value});
 for (const value of [
  {...identity, repositoryId:2}, {...identity, number:3}, {...identity, head:'unknown'},
  {...identity, base:'unknown'}, {...identity, state:'unknown'}, {...identity, draft:null},
  {reason:'IDENTITY_ONLY'}, {...identity,get head(){ throw Error('untrusted getter'); }}
 ]) assertBlocked(await reconcile(value),'IDENTITY_UNKNOWN');
 const proxy = new Proxy(identity,{getOwnPropertyDescriptor(){throw Error('untrusted trap');}});
 assertBlocked(await reconcile(proxy),'READ_FAILED');
 assertBlocked(await reconcile({...identity,head:'c'.repeat(40)}),'HEAD_CHANGED');
 assertBlocked(await reconcile({reason:'RATE_OR_PERMISSION_UNKNOWN'}),'RATE_OR_PERMISSION_UNKNOWN');
 assertBlocked(await reconcile({reason:'RESPONSE_LIMIT'}),'READ_FAILED');
 assertBlocked(await reconcilePullTrigger(actions,{clock:() => 100,readIdentity:async () => {
  throw Error('offline');
 }}),'READ_FAILED');
 for (const finishedAt of [99,120101]) {
  const samples = [100,finishedAt];
  assertBlocked(await reconcile(identity,() => samples.shift()),'STALE_EVENT');
 }
});

test('resolves trusted repository scopes and rejects malformed or path-traversal scopes', async () => {
 assert.deepEqual(resolveTrustedScope(), {
  repository: 'Jamula/SoftwareFactory',
  repositoryId: 1471342715,
  branch: 'main',
  workflowPath: '.github/workflows/shadow-reconcile.yml',
  workflowBranch: 'refs/heads/main',
  workflowRef: 'Jamula/SoftwareFactory/.github/workflows/shadow-reconcile.yml@refs/heads/main',
  apiRoot: 'https://api.github.com/repos/Jamula/SoftwareFactory',
  explicitRepositoryId: false
 });
 const custom = resolveTrustedScope({
  scope: {repository: 'Jamula/FamilyTree', repositoryId: 2026, branch: 'release/v1', workflowPath: '.github/workflows/reconcile.yaml'}
 });
 assert.equal(custom.workflowRef, 'Jamula/FamilyTree/.github/workflows/reconcile.yaml@refs/heads/release/v1');
 assert.equal(custom.explicitRepositoryId, true);

 for (const bad of [
  null, [], new Proxy({}, {}), Object.create(new Proxy({}, {has() { throw Error('proto trap'); }})),
  {get scope() { return {}; }}, {scope: null},
  {get repository() { return 'Jamula/SoftwareFactory'; }},
  {repository: 'Jamula/FamilyTree'},
  {repository: '../evil', repositoryId: 1}, {repository: 'Jamula/..', repositoryId: 1},
  {repository: 'bad', repositoryId: 1}, {repositoryId: 0},
  {branch: 'bad..ref'}, {branch: 'bad//ref'},
  {branch: 'bad/'}, {branch: 'main.lock'}, {workflowPath: 'workflows/bad.yml'}
 ]) {
  assert.equal(resolveTrustedScope(bad), null);
 }
 assert.equal((await readPullIdentity(2, () => assert.fail('unexpected'), null)).reason, 'TRUST_UNKNOWN');
 assertBlocked(await reconcilePullTrigger(actions, null), 'TRUST_UNKNOWN');
 assertBlocked(await reconcilePullTrigger(null, {}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcilePullTrigger(Object.create(actions), {}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcilePullTrigger({...actions, get GITHUB_RUN_ID() { throw Error('getter'); }}, {}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcilePullTrigger(actions, {get clock() { throw Error('getter'); }}), 'TRUST_UNKNOWN');

 const consumerRepo = {id: 2026, full_name: 'Jamula/FamilyTree'};
 const consumerPull = {
  number: 5, head: {repo: consumerRepo, sha: e.head},
  base: {repo: consumerRepo, sha: trust.workflowSha, ref: 'trunk'}, state: 'open', draft: false
 };
 assert.equal((await readPullIdentity(5, async () => new Response(JSON.stringify(consumerPull)),
  {repository: 'Jamula/FamilyTree', repositoryId: 9999, branch: 'trunk'})).reason, 'IDENTITY_UNKNOWN');
 const scopedEnv = {
  ...actions,
  GITHUB_REPOSITORY_ID: '2026',
  GITHUB_WORKFLOW_REF: 'Jamula/FamilyTree/.github/workflows/shadow-reconcile.yml@refs/heads/trunk',
  FACTORY_PULL_NUMBER: '5'
 };
 const matched = await reconcilePullTrigger(scopedEnv, {
  clock: () => 100,
  request: async url => {
   assert.equal(url, 'https://api.github.com/repos/Jamula/FamilyTree/pulls/5');
   return new Response(JSON.stringify(consumerPull));
  },
  scope: {repository: 'Jamula/FamilyTree', repositoryId: 2026, branch: 'trunk'}
 });
 assert.equal(matched.reconciled, true);
 assert.equal(matched.repositoryId, 2026);
});

test('reconciles same-repository completed review triggers and rejects stale or moved heads', async () => {
 const repo = {id: 1471342715, full_name: 'Jamula/SoftwareFactory'};
 const pullPayload = {
  number: 2, head: {repo, sha: e.head}, base: {repo, sha: trust.workflowSha, ref: 'main'},
  state: 'open', draft: false
 };
 const reviewPayload = {
  id: 77, user: {login: 'copilot-pull-request-reviewer[bot]', id: 99},
  state: 'APPROVED', commit_id: e.head, body: 'untrusted review body'
 };
 const request = async url => new Response(JSON.stringify(url.includes('/reviews/') ? reviewPayload : pullPayload));
 const readRes = await readReviewIdentity(2, 77, request);
 assert.equal(readRes.reason, 'IDENTITY_ONLY');
 assert.equal(readRes.reviewer, 'copilot-pull-request-reviewer[bot]');
 assert.equal(JSON.stringify(readRes).includes('untrusted'), false);

 assert.equal((await readReviewIdentity(2, 77, request, null)).reason, 'TRUST_UNKNOWN');
 assert.equal((await readReviewIdentity(0, 77, request)).reason, 'INVALID_PULL');
 assert.equal((await readReviewIdentity(2, 0, request)).reason, 'INVALID_REVIEW');
 assert.equal((await readReviewIdentity(2, 77, async () => new Response(null, {status: 401}))).reason, 'RATE_OR_PERMISSION_UNKNOWN');
 assert.equal((await readReviewIdentity(2, 77, async url =>
  url.includes('/reviews/') ? new Response(null, {status: 500}) : new Response(JSON.stringify(pullPayload)))).reason, 'READ_FAILED');
 for (const badReview of [
  {...reviewPayload, id: 78}, {...reviewPayload, user: {login: 'bad login', id: 99}},
  {...reviewPayload, user: {login: 'reviewer', id: 0}}, {...reviewPayload, state: 'PENDING'},
  {...reviewPayload, commit_id: 'bad'}
 ]) {
  assert.equal((await readReviewIdentity(2, 77, async url =>
   new Response(JSON.stringify(url.includes('/reviews/') ? badReview : pullPayload)))).reason, 'IDENTITY_UNKNOWN');
 }

 // Re-read pull identity after review GET and reject mid-read head, state/base/draft, repo ID, or HTTP changes.
 for (const [secondPull, expectedReason] of [
  [{...pullPayload, head: {repo, sha: 'c'.repeat(40)}}, 'HEAD_CHANGED'],
  [{...pullPayload, state: 'closed'}, 'PULL_STATE_CHANGED'],
  [{...pullPayload, draft: true}, 'PULL_STATE_CHANGED'],
  [{...pullPayload, base: {...pullPayload.base, sha: 'd'.repeat(40)}}, 'PULL_STATE_CHANGED'],
  [{...pullPayload, base: {...pullPayload.base, repo: {...repo, id: 2}}, head: {...pullPayload.head, repo: {...repo, id: 2}}}, 'IDENTITY_UNKNOWN']
 ]) {
  let pullReads = 0;
  const changingRequest = async url => url.includes('/reviews/')
   ? new Response(JSON.stringify(reviewPayload))
   : new Response(JSON.stringify(++pullReads === 1 ? pullPayload : secondPull));
  assert.equal((await readReviewIdentity(2, 77, changingRequest)).reason, expectedReason);
 }
 {
  let pullReads = 0;
  assert.equal((await readReviewIdentity(2, 77, async url =>
   url.includes('/reviews/')
    ? new Response(JSON.stringify(reviewPayload))
    : (++pullReads === 1 ? new Response(JSON.stringify(pullPayload)) : new Response(null, {status: 503}))
  )).reason, 'READ_FAILED');
 }

 const reviewEnv = {...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_REVIEW_ID: '77'};
 const matched = await reconcileReviewTrigger(reviewEnv, {clock: () => 100, request});
 assert.equal(matched.reconciled, true);
 assert.equal(matched.reason, 'REVIEW_IDENTITY_MATCHED');
 assert.equal(matched.reviewState, 'APPROVED');

 {
  let pullReads = 0;
  const midReadStateChange = async url => url.includes('/reviews/')
   ? new Response(JSON.stringify(reviewPayload))
   : new Response(JSON.stringify(++pullReads === 1 ? pullPayload : {...pullPayload, draft: true}));
  assertBlocked(await reconcileReviewTrigger(reviewEnv, {clock: () => 100, request: midReadStateChange}), 'PULL_STATE_CHANGED');
 }

 assertBlocked(await reconcileReviewTrigger(reviewEnv, null), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileReviewTrigger({...reviewEnv, GITHUB_EVENT_NAME: 'pull_request'}, {clock: () => 100, request}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileReviewTrigger({...reviewEnv, FACTORY_PULL_NUMBER: '0'}, {clock: () => 100, request}), 'INVALID_PULL');
 assertBlocked(await reconcileReviewTrigger({...reviewEnv, FACTORY_REVIEW_ID: '0'}, {clock: () => 100, request}), 'INVALID_REVIEW');
 assertBlocked(await reconcileReviewTrigger(reviewEnv, {
  clock: () => 100,
  readIdentity: async () => ({...readRes, commitId: 'c'.repeat(40)})
 }), 'HEAD_CHANGED');
 assertBlocked(await reconcileReviewTrigger(reviewEnv, {
  clock: () => 100,
  readIdentity: async () => ({reason: 'IDENTITY_ONLY'})
 }), 'IDENTITY_UNKNOWN');
});

test('reconciles completed workflow_run check triggers and rejects forks or non-completed runs', async () => {
 const repo = {id: 1471342715, full_name: 'Jamula/SoftwareFactory'};
 const runPayload = {
  id: 501, repository: repo, head_repository: repo, head_sha: e.head,
  status: 'completed', conclusion: 'success', event: 'pull_request',
  display_title: 'untrusted PR title'
 };
 const request = async url => {
  assert.equal(url, 'https://api.github.com/repos/Jamula/SoftwareFactory/actions/runs/501');
  return new Response(JSON.stringify(runPayload));
 };
 const readRes = await readCheckRunIdentity(501, request);
 assert.equal(readRes.reason, 'IDENTITY_ONLY');
 assert.equal(JSON.stringify(readRes).includes('untrusted'), false);

 assert.equal((await readCheckRunIdentity(501, request, null)).reason, 'TRUST_UNKNOWN');
 assert.equal((await readCheckRunIdentity(0, request)).reason, 'INVALID_CHECK');
 assert.equal((await readCheckRunIdentity(501, async () => new Response(null, {status: 429}))).reason, 'RATE_OR_PERMISSION_UNKNOWN');
 for (const badRun of [
  {...runPayload, id: 502},
  {...runPayload, repository: {...repo, full_name: 'other/repo'}},
  {...runPayload, head_repository: {id: 999, full_name: 'fork/SoftwareFactory'}},
  {...runPayload, head_repository: {...repo, id: 999}},
  {...runPayload, head_sha: 'bad'},
  {...runPayload, status: 'in_progress'},
  {...runPayload, conclusion: 'unknown'},
  {...runPayload, event: 'Bad-Event'}
 ]) {
  assert.equal((await readCheckRunIdentity(501, async () => new Response(JSON.stringify(badRun)))).reason, 'IDENTITY_UNKNOWN');
 }
 assert.equal((await readCheckRunIdentity(501, request, {repositoryId: 999})).reason, 'IDENTITY_UNKNOWN');

 const checkEnv = {
  ...actions, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main',
  FACTORY_WORKFLOW_RUN_ID: '501', FACTORY_CHECK_HEAD: e.head
 };
 const matched = await reconcileCheckTrigger(checkEnv, {clock: () => 100, request});
 assert.equal(matched.reconciled, true);
 assert.equal(matched.reason, 'CHECK_IDENTITY_MATCHED');
 assert.equal(matched.conclusion, 'success');

 assertBlocked(await reconcileCheckTrigger(checkEnv, null), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileCheckTrigger({...checkEnv, GITHUB_REF: 'refs/heads/dev'}, {clock: () => 100, request}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileCheckTrigger({...checkEnv, FACTORY_WORKFLOW_RUN_ID: '0'}, {clock: () => 100, request}), 'INVALID_CHECK');
 assertBlocked(await reconcileCheckTrigger(checkEnv, {
  clock: () => 100,
  readIdentity: async () => ({...readRes, head: 'c'.repeat(40)})
 }), 'HEAD_CHANGED');
 assertBlocked(await reconcileCheckTrigger(checkEnv, {
  clock: () => 100,
  readIdentity: async () => ({reason: 'IDENTITY_ONLY'})
 }), 'IDENTITY_UNKNOWN');
});

test('reconciles protected main push triggers and rejects forks, unprotected branches or head drift', async () => {
 const repoPayload = {id: 1471342715, full_name: 'Jamula/SoftwareFactory', fork: false};
 const branchPayload = {
  name: 'main', protected: true,
  commit: {sha: trust.workflowSha, commit: {message: 'untrusted commit message'}}
 };
 const request = async url => new Response(JSON.stringify(url.endsWith('/branches/main') ? branchPayload : repoPayload));
 const readRes = await readMainIdentity(request);
 assert.deepEqual(readRes, {
  shadow: true, evidenceComplete: false, reason: 'IDENTITY_ONLY',
  repositoryId: 1471342715, branch: 'main', head: trust.workflowSha, branchProtected: true
 });

 assert.equal((await readMainIdentity(request, null)).reason, 'TRUST_UNKNOWN');
 assert.equal((await readMainIdentity(async url =>
  url.endsWith('/branches/main') ? new Response(JSON.stringify(branchPayload)) : new Response(null, {status: 503}))).reason, 'READ_FAILED');
 assert.equal((await readMainIdentity(async url =>
  url.endsWith('/branches/main') ? new Response(null, {status: 403}) : new Response(JSON.stringify(repoPayload)))).reason, 'RATE_OR_PERMISSION_UNKNOWN');
 assert.equal((await readMainIdentity(request, {repositoryId: 999})).reason, 'IDENTITY_UNKNOWN');
 for (const [repoOverride, branchOverride] of [
  [{...repoPayload, fork: true}, branchPayload],
  [repoPayload, {...branchPayload, protected: false}],
  [repoPayload, {...branchPayload, name: 'dev'}],
  [repoPayload, {...branchPayload, commit: {sha: 'bad'}}]
 ]) {
  assert.equal((await readMainIdentity(async url =>
   new Response(JSON.stringify(url.endsWith('/branches/main') ? branchOverride : repoOverride)))).reason, 'IDENTITY_UNKNOWN');
 }

 const mainEnv = {...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main'};
 const matched = await reconcileMainTrigger(mainEnv, {clock: () => 100, request});
 assert.equal(matched.reconciled, true);
 assert.equal(matched.reason, 'MAIN_IDENTITY_MATCHED');

 assertBlocked(await reconcileMainTrigger(mainEnv, null), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileMainTrigger({...mainEnv, GITHUB_REF: 'refs/heads/other'}, {clock: () => 100, request}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileMainTrigger({...mainEnv, FACTORY_MAIN_HEAD: e.head}, {clock: () => 100, request}), 'TRUST_UNKNOWN');
 assertBlocked(await reconcileMainTrigger(mainEnv, {
  clock: () => 100,
  readIdentity: async () => ({...readRes, head: e.head})
 }), 'HEAD_CHANGED');
 assertBlocked(await reconcileMainTrigger(mainEnv, {
  clock: () => 100,
  readIdentity: async () => ({reason: 'IDENTITY_ONLY'})
 }), 'IDENTITY_UNKNOWN');
});

test('orchestrates pull, review, check, main, issue and manual triggers through event-journal snapshots', async () => {
 const repo = {id: 1471342715, full_name: 'Jamula/SoftwareFactory', fork: false};
 let currentPullHead = e.head;
 let currentMainHead = trust.workflowSha;
 let apiCalls = 0;
 const request = async url => {
  apiCalls++;
  if (url.endsWith('/repos/Jamula/SoftwareFactory')) return new Response(JSON.stringify(repo));
  if (url.endsWith('/branches/main')) {
   return new Response(JSON.stringify({name: 'main', protected: true, commit: {sha: currentMainHead}}));
  }
  if (url.endsWith('/pulls/2')) {
   return new Response(JSON.stringify({
    number: 2, head: {repo, sha: currentPullHead}, base: {repo, sha: trust.workflowSha, ref: 'main'},
    state: 'open', draft: false
   }));
  }
  if (url.includes('/pulls/2/reviews/77')) {
   return new Response(JSON.stringify({
    id: 77, user: {login: 'reviewer-a', id: 10}, state: 'APPROVED', commit_id: e.head
   }));
  }
  if (url.endsWith('/actions/runs/501')) {
   return new Response(JSON.stringify({
    id: 501, repository: repo, head_repository: repo, head_sha: e.head,
    status: 'completed', conclusion: 'success', event: 'pull_request'
   }));
  }
  if (url.endsWith('/issues/42')) {
   return new Response(JSON.stringify({
    number: 42, state: 'open', repository_url: 'https://api.github.com/repos/Jamula/SoftwareFactory'
   }));
  }
  throw Error('unexpected url ' + url);
 };

 let snapshot;
 const triggers = [
  {...actions, GITHUB_RUN_ID: 'run-pull'},
  {...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_REVIEW_ID: '77', GITHUB_RUN_ID: 'run-review'},
  {...actions, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main', FACTORY_WORKFLOW_RUN_ID: '501', FACTORY_CHECK_HEAD: e.head, GITHUB_RUN_ID: 'run-check'},
  {...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: 'run-main'},
  {...actions, GITHUB_EVENT_NAME: 'issues', GITHUB_REF: 'refs/heads/main', FACTORY_ISSUE_NUMBER: '42', GITHUB_RUN_ID: 'run-issue'},
  {...actions, GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', FACTORY_ISSUE_NUMBER: '42', GITHUB_RUN_ID: 'run-manual'}
 ];
 for (const triggerEnv of triggers) {
  const res = await reconcileEventTrigger(triggerEnv, {clock: () => 1000, request, snapshot});
  assert.equal(res.reconciled, true);
  assert.equal(res.reason, 'SHADOW_RECONCILED');
  assert.equal(res.liveDispatch, false);
  assert.equal(res.liveMerge, false);
  snapshot = JSON.parse(JSON.stringify(res.snapshot));
 }
 assert.equal(snapshot.entries.length, 6);

 // Replaying a completed delivery against the imported snapshot coalesces with zero network calls.
 apiCalls = 0;
 const dup = await reconcileEventTrigger({...actions, GITHUB_RUN_ID: 'run-pull'}, {
  clock: () => 2000, request, snapshot
 });
 assert.equal(dup.reconciled, false);
 assert.equal(dup.reason, 'DUPLICATE_DELIVERY');
 assert.equal(apiCalls, 0);

 // Conflicting delivery with same run ID is rejected before network calls.
 const conflict = await reconcileEventTrigger({...actions, GITHUB_RUN_ID: 'run-pull', FACTORY_PULL_NUMBER: '9'}, {
  clock: () => 2000, request, snapshot
 });
 assert.equal(conflict.reason, 'DELIVERY_CONFLICT');
 assert.equal(apiCalls, 0);

 // Simulate crashed uncompleted review claim in a cross-run snapshot and recover it after restart.
 const crashedJournal = openEventJournal(':memory:');
 let crashedSnapshot;
 try {
  crashedJournal.enqueue({repositoryId: 1471342715, deliveryId: 'crashed-review', kind: 'review', subject: 2, head: e.head});
  crashedJournal.claim(1471342715, 'dead-runner', 100, 1000);
  // At t=500 the dead runner's lease (until 1100) is still active -> CLAIM_PENDING, not DUPLICATE_DELIVERY!
  const inFlight = await reconcileEventTrigger({
   ...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_REVIEW_ID: '77', GITHUB_RUN_ID: 'crashed-review'
  }, {
   clock: () => 500, request, journal: crashedJournal
  });
  assert.equal(inFlight.reconciled, false);
  assert.equal(inFlight.reason, 'CLAIM_PENDING');
  crashedSnapshot = JSON.parse(JSON.stringify(inFlight.snapshot));
 } finally {
  crashedJournal.close();
 }
 // At t=2000 an unrelated push trigger does NOT falsely acknowledge 'crashed-review' without its reviewId; default retry deferral (3600000 ms) backs off 'crashed-review' so later work is not starved once its 30s lease expires.
 const queuedBehind = await reconcileEventTrigger({...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: 'after-crash'}, {
  clock: () => 2000, request, snapshot: crashedSnapshot
 });
 assert.equal(queuedBehind.reconciled, false);
 assert.equal(queuedBehind.reason, 'QUEUED');
 assert.equal(queuedBehind.recoveredDeliveryId, 'crashed-review');
 assert.equal(queuedBehind.recoveryReason, 'EVIDENCE_UNKNOWN');
 assert.equal(queuedBehind.snapshot.entries.find(row => row.deliveryId === 'crashed-review').retryAfter, 3602000);

 // At t=33000 (after the 30s lease expires, while 'crashed-review' is still deferred until 3602000), 'after-crash' proceeds immediately without starvation!
 const replayMain = await reconcileEventTrigger({...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: 'after-crash'}, {
  clock: () => 33000, request, snapshot: JSON.parse(JSON.stringify(queuedBehind.snapshot))
 });
 assert.equal(replayMain.reconciled, true);
 assert.equal(replayMain.reason, 'SHADOW_RECONCILED');

 // Once the retry deferral elapses (t=3602000), re-delivering 'crashed-review' with FACTORY_REVIEW_ID recovers and reconciles it cleanly.
 const retriedReview = await reconcileEventTrigger({
  ...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_REVIEW_ID: '77', GITHUB_RUN_ID: 'crashed-review'
 }, {
  clock: () => 3602000, request, snapshot: JSON.parse(JSON.stringify(replayMain.snapshot))
 });
 assert.equal(retriedReview.reconciled, true);
 assert.equal(retriedReview.reason, 'SHADOW_RECONCILED');

 // Explicit deferUnknown override remains supported and fails closed on invalid callback type.
 assert.equal((await reconcileEventTrigger(actions, {
  clock: () => 100, request, deferUnknown: 'invalid'
 })).reason, 'RUNTIME_UNKNOWN');

 // A read finishing after 120s fails closed as STALE_EVENT without completing the delivery, even when leaseMs is 3600000.
 const slowSamples = [100, 100, 121100];
 const staleRes = await reconcileEventTrigger(
  {...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: 'slow-121s'},
  {leaseMs: 3600000, clock: () => slowSamples.shift(), request}
 );
 assert.equal(staleRes.reconciled, false);
 assert.equal(staleRes.reason, 'STALE_EVENT');
 assert.equal(staleRes.snapshot.entries[0].completed, false);
 const recoveredAfterStale = await reconcileEventTrigger(
  {...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', GITHUB_RUN_ID: 'slow-121s'},
  {leaseMs: 3600000, clock: () => 3700000, request, snapshot: JSON.parse(JSON.stringify(staleRes.snapshot))}
 );
 assert.equal(recoveredAfterStale.reconciled, true);
 assert.equal(recoveredAfterStale.reason, 'SHADOW_RECONCILED');

 // Moved PR head on review trigger supersedes the hint without granting authority.
 currentPullHead = 'c'.repeat(40);
 const superseded = await reconcileEventTrigger(
  {...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_REVIEW_ID: '77', GITHUB_RUN_ID: 'moved-review'},
  {clock: () => 3000, request}
 );
 assert.equal(superseded.reconciled, false);
 assert.equal(superseded.reason, 'SHADOW_HEAD_SUPERSEDED');
 currentMainHead = currentPullHead;
 assert.equal(currentMainHead.length, 40);
});

test('scoped journal reader and event trigger reject malformed inputs, snapshots and mismatched evidence', async () => {
 const invalidReader = createScopedJournalReader(null);
 assert.equal(await invalidReader({repositoryId: 1471342715, kind: 'pull', subject: 1, head: e.head}), null);
 assert.equal(await createScopedJournalReader({}, null)({repositoryId: 1471342715, kind: 'pull', subject: 1, head: e.head}), null);
 assert.equal(await createScopedJournalReader({}, {reviewHint: {bad: 1}})({repositoryId: 1471342715, kind: 'pull', subject: 1, head: e.head}), null);

 const reader = createScopedJournalReader({}, {
  request: async url => {
   if (url.includes('/pulls/99')) return new Response(null, {status: 404});
   if (url.includes('/pulls/4') || url.includes('/pulls/5')) {
    const num = Number(url.split('/pulls/')[1].split('/')[0]);
    const headSha = num === 5 ? 'd'.repeat(40) : e.head;
    const repo = {id: 1471342715, full_name: 'Jamula/SoftwareFactory'};
    return new Response(JSON.stringify({
     number: num, head: {repo, sha: headSha}, base: {repo, sha: trust.workflowSha, ref: 'main'},
     state: 'open', draft: false
    }));
   }
   if (url.includes('/actions/runs/')) return new Response(null, {status: 404});
   if (url.includes('/issues/10')) return new Response(JSON.stringify({number: 10, state: 'open', pull_request: {}, repository_url: 'https://api.github.com/repos/Jamula/SoftwareFactory'}));
   if (url.includes('/issues/11')) return new Response(null, {status: 404});
   if (url.endsWith('/branches/main')) return new Response(null, {status: 404});
   return new Response(JSON.stringify({id: 1471342715, full_name: 'Jamula/SoftwareFactory', fork: false}));
  }
 });

 assert.equal(await reader(null), null);
 assert.equal(await reader(new Proxy({}, {getOwnPropertyDescriptor() { throw Error('trap'); }})), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'bogus_kind', subject: 10, head: e.head}), null);
 assert.equal(await reader({repositoryId: 99, kind: 'pull', subject: 1, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'pull', subject: 99, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'review', subject: 99, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'review', subject: 4, head: e.head}), null);
 assert.equal((await reader({repositoryId: 1471342715, kind: 'review', subject: 5, head: e.head})).head, 'd'.repeat(40));
 assert.equal(await reader({repositoryId: 1471342715, kind: 'check', subject: 99, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'main', subject: 1, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'main', subject: 0, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'issue', subject: 0, head: e.head}), null);
 assert.equal(await reader({repositoryId: 1471342715, kind: 'issue', subject: 11, head: e.head}), null);

 const readerIssuePull = createScopedJournalReader({}, {
  request: async url => {
   if (url.includes('/issues/10')) {
    return new Response(JSON.stringify({
     number: 10, state: 'open', pull_request: {},
     repository_url: 'https://api.github.com/repos/Jamula/SoftwareFactory'
    }));
   }
   if (url.endsWith('/branches/main')) {
    return new Response(JSON.stringify({name: 'main', protected: true, commit: {sha: trust.workflowSha}}));
   }
   return new Response(JSON.stringify({id: 1471342715, full_name: 'Jamula/SoftwareFactory', fork: false}));
  }
 });
 assert.equal(await readerIssuePull({repositoryId: 1471342715, kind: 'issue', subject: 10, head: trust.workflowSha}), null);

 const readerHintMismatch = createScopedJournalReader({}, {
  reviewHint: {deliveryId: 'd-hint', subject: 2, reviewId: 77},
  request: async url => {
   const repo = {id: 1471342715, full_name: 'Jamula/SoftwareFactory'};
   if (url.includes('/reviews/77')) {
    return new Response(JSON.stringify({id: 77, user: {login: 'rev', id: 1}, state: 'COMMENTED', commit_id: 'f'.repeat(40)}));
   }
   return new Response(JSON.stringify({
    number: 2, head: {repo, sha: e.head}, base: {repo, sha: trust.workflowSha, ref: 'main'},
    state: 'open', draft: false
   }));
  }
 });
 assert.equal(await readerHintMismatch({repositoryId: 1471342715, deliveryId: 'd-hint', kind: 'review', subject: 2, head: e.head}), null);
 const readerHintFailed = createScopedJournalReader({}, {
  reviewHint: {deliveryId: 'd-hint', subject: 2, reviewId: 77},
  request: async () => new Response(null, {status: 404})
 });
 assert.equal(await readerHintFailed({repositoryId: 1471342715, deliveryId: 'd-hint', kind: 'review', subject: 2, head: e.head}), null);

 for (const [badEnv, badOpts, expected] of [
  [null, {}, 'TRUST_UNKNOWN'],
  [actions, null, 'TRUST_UNKNOWN'],
  [{...actions, GITHUB_EVENT_NAME: 'schedule'}, {}, 'TRUST_UNKNOWN'],
  [{...actions, GITHUB_WORKFLOW_SHA: 'bad'}, {}, 'TRUST_UNKNOWN'],
  [{...actions, FACTORY_PULL_NUMBER: '0'}, {}, 'INVALID_PULL'],
  [{...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_PULL_NUMBER: '0', FACTORY_REVIEW_ID: '1'}, {}, 'INVALID_PULL'],
  [{...actions, GITHUB_EVENT_NAME: 'pull_request_review', FACTORY_REVIEW_ID: '0'}, {}, 'INVALID_REVIEW'],
  [{...actions, GITHUB_EVENT_NAME: 'workflow_run', GITHUB_REF: 'refs/heads/main', FACTORY_WORKFLOW_RUN_ID: '0', FACTORY_CHECK_HEAD: e.head}, {}, 'INVALID_CHECK'],
  [{...actions, GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main', FACTORY_MAIN_HEAD: e.head}, {}, 'TRUST_UNKNOWN'],
  [{...actions, GITHUB_EVENT_NAME: 'issues', GITHUB_REF: 'refs/heads/main', FACTORY_ISSUE_NUMBER: '0'}, {}, 'INVALID_ISSUE'],
  [{...actions, GITHUB_RUN_ID: 'bad id'}, {}, 'INVALID_EVENT'],
  [actions, {clock: () => 100, snapshot: {}}, 'INVALID_SNAPSHOT'],
  [actions, {clock: () => 100, journal: null}, 'JOURNAL_UNAVAILABLE']
 ]) {
  assert.equal((await reconcileEventTrigger(badEnv, badOpts)).reason, expected);
 }
});
