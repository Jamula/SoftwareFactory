import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readBranchHealth,
  readCandidatePullMetadata,
  readPullSignals
} from '../../tools/engineering-factory/pull-signals.mjs';

const repo={id:1471342715,full_name:'Jamula/SoftwareFactory'};
const head='a'.repeat(40), base='b'.repeat(40);
const pull={number:42,base:{repo,ref:'main',sha:base},head:{repo,sha:head},state:'open',draft:false};
const review={id:100,user:{login:'copilot-pull-request-reviewer[bot]',id:946600},state:'COMMENTED',
 commit_id:head,submitted_at:'2026-11-26T19:00:00Z',body:'untrusted text must not escape'};
const check={id:200,name:'build-test',head_sha:head,status:'completed',conclusion:'success',
 completed_at:'2026-11-26T19:00:00Z',app:{id:15368,slug:'github-actions'},output:{title:'ignored'}};
const response=value=>new Response(JSON.stringify(value));
const read=async(url,options)=>{
 assert.equal(options.method,'GET');assert.equal(options.redirect,'error');
 assert.equal(options.headers.authorization,undefined);
 if(url.endsWith('/pulls/42'))return response(pull);
 if(url.includes('/reviews?'))return response([review]);
 if(url.includes('/check-runs?'))return response({total_count:1,check_runs:[check]});
 throw Error('unexpected endpoint');
};

test('reads same-repository current-head review and check metadata without comment or output text',async()=>{
 const result=await readPullSignals(42,head,read);
 assert.deepEqual(result,{shadow:true,evidenceComplete:false,reason:'PULL_SIGNALS_METADATA_ONLY',
  repositoryId:1471342715,number:42,head,base,state:'open',draft:false,
  reviewSnapshotComplete:true,reviews:[{id:100,reviewer:'copilot-pull-request-reviewer[bot]',reviewerId:946600,
   state:'COMMENTED',head,submittedAt:'2026-11-26T19:00:00Z'}],
  checkSnapshotComplete:true,checks:[{id:200,name:'build-test',appId:15368,app:'github-actions',head,
   status:'completed',conclusion:'success',completedAt:'2026-11-26T19:00:00Z'}],
  liveDispatch:false,liveMerge:false});
 assert.equal(JSON.stringify(result).includes('untrusted'),false);
 assert.equal(JSON.stringify(result).includes('ignored'),false);
});

test('rejects invalid numbers and changed heads before reading review/check endpoints',async()=>{
 let calls=0;const count=async(...args)=>{calls++;return read(...args);};
 assert.equal((await readPullSignals(0,head,count)).reason,'INVALID_PULL');
 assert.equal((await readPullSignals(42,'bad',count)).reason,'INVALID_HEAD');
 assert.equal((await readPullSignals(42,'c'.repeat(40),count)).reason,'HEAD_CHANGED');
 assert.equal(calls,1);
});

test('rejects snapshots when the pull head changes during metadata reads',async()=>{
 let pullReads=0;
 const changed={...pull,head:{...pull.head,sha:'c'.repeat(40)}};
 const mock=async(url,options)=>{
  if(url.endsWith('/pulls/42'))return response(++pullReads===1?pull:changed);
  return read(url,options);
 };
 assert.equal((await readPullSignals(42,head,mock)).reason,'HEAD_CHANGED');
 assert.equal(pullReads,2);
});

test('requires a complete final pull reread and rejects changed pull state',async()=>{
 const withFinal=final=>{
  let reads=0;
  return async(url,options)=>url.endsWith('/pulls/42')?
   (++reads===1?response(pull):final):read(url,options);
 };
 for(const [final,reason] of [
  [new Response(null,{status:403}),'RATE_OR_PERMISSION_UNKNOWN'],
  [new Response(null,{status:503}),'READ_FAILED'],
  [response({}),'PULL_IDENTITY_UNKNOWN']
 ]) assert.equal((await readPullSignals(42,head,withFinal(final))).reason,reason);
 for(const changed of [
  {...pull,base:{...pull.base,sha:'d'.repeat(40)}},
  {...pull,state:'closed'},
  {...pull,draft:true}
 ]) assert.equal((await readPullSignals(42,head,withFinal(response(changed)))).reason,'PULL_STATE_CHANGED');
});

test('fails closed for read failures, permission limits, oversized and paginated responses',async()=>{
 for(const status of [401,403,429])
  assert.equal((await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?
   response(pull):new Response(null,{status}))).reason,'RATE_OR_PERMISSION_UNKNOWN');
 for(const status of [404,204])
  assert.equal((await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?
   response(pull):new Response(null,{status}))).reason,'READ_FAILED');
 assert.equal((await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?
  response(pull):new Response('x'.repeat(524289)))).reason,'RESPONSE_LIMIT');
 assert.equal((await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?new Response(JSON.stringify([review]),{headers:{link:'<next>; rel="next"'}}):
  response({total_count:1,check_runs:[check]}))).reason,'PAGE_LIMIT');
 assert.equal((await readPullSignals(42,head,async()=>{throw Error('offline');})).reason,'PULL_IDENTITY_UNKNOWN');
});

test('rejects malformed, duplicate, cross-head and incomplete review inventories',async()=>{
 const result=async reviews=>readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response(reviews):response({total_count:1,check_runs:[check]}));
 for(const row of [{...review,state:'UNKNOWN'},{...review,commit_id:'c'.repeat(40)},
  {...review,user:null},{...review,id:0},{...review,submitted_at:'bad'},{...review,user:{login:'bad login'}},{...review,user:{login:123}},{...review,user:{login:['valid']}},{...review,user:{login:'valid',id:0}}])
  assert.notEqual((await result([row])).reason,'PULL_SIGNALS_METADATA_ONLY');
 assert.equal((await result([review,review])).reason,'REVIEW_METADATA_UNKNOWN');
});

test('rejects incomplete and calendar-invalid GitHub API timestamps',async()=>{
 const result=(reviews,checks=[check])=>readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response(reviews):response({total_count:checks.length,check_runs:checks}));
 assert.equal((await result([{...review,submitted_at:'2026-11-26'}])).reason,'REVIEW_METADATA_UNKNOWN');
 assert.equal((await result([{...review,submitted_at:'2026-02-30T19:00:00Z'}])).reason,'REVIEW_METADATA_UNKNOWN');
 assert.equal((await result([],[{...check,completed_at:'2026-02-30T19:00:00Z'}])).reason,'CHECK_METADATA_UNKNOWN');
});

test('rejects malformed, wrong-head, duplicate and inconsistent check metadata',async()=>{
 const result=async value=>readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response([]):response(value));
 for(const value of [
  {total_count:2,check_runs:[check]}, {total_count:1,check_runs:[{...check,head_sha:'c'.repeat(40)}]},
  {total_count:1,check_runs:[{...check,conclusion:'unknown'}]},
  {total_count:1,check_runs:[{...check,status:'in_progress',conclusion:'success'}]},
  {total_count:1,check_runs:[{...check,app:null}]},
  {total_count:1,check_runs:[{...check,app:{...check.app,slug:['github-actions']}}]},
  {total_count:1,check_runs:[{...check,id:0}]}
 ]) assert.notEqual((await result(value)).reason,'PULL_SIGNALS_METADATA_ONLY');
 assert.equal((await result({total_count:101,check_runs:[]})).reason,'PAGE_LIMIT');
});

test('review and check rate failures remain incomplete and never imply policy eligibility',async()=>{
 const mock=async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response([review]):new Response(null,{status:429});
 assert.deepEqual(await readPullSignals(42,head,mock),{shadow:true,evidenceComplete:false,reason:'RATE_OR_PERMISSION_UNKNOWN'});
});

test('accepts complete empty inventories and in-progress metadata with unknown user ID',async()=>{
 const noRecords=await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response([]):response({total_count:0,check_runs:[]}));
 assert.equal(noRecords.reviewSnapshotComplete,true);
 assert.deepEqual(noRecords.reviews,[]);
 assert.deepEqual(noRecords.checks,[]);
 const pendingReview={...review,state:'PENDING',submitted_at:null,user:{login:'review-bot',id:null}};
 const pendingCheck={...check,status:'in_progress',conclusion:null,completed_at:null};
 const pending=await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response([pendingReview]):response({total_count:1,check_runs:[pendingCheck]}));
 assert.equal(pending.reviews[0].reviewerId,null);
 assert.equal(pending.reviews[0].submittedAt,null);
 assert.equal(pending.checks[0].conclusion,null);
 const withoutSubmittedAt={...pendingReview};
 delete withoutSubmittedAt.submitted_at;
 const absentTimestamp=await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response([withoutSubmittedAt]):response({total_count:0,check_runs:[]}));
 assert.equal(absentTimestamp.reviews[0].submittedAt,null);
 for(const status of ['queued','in_progress','waiting','requested','pending']){
  const checkRow={...check,id:300,status,conclusion:null,completed_at:null};
  const snapshot=await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
   url.includes('/reviews?')?response([]):response({total_count:1,check_runs:[checkRow]}));
  assert.equal(snapshot.checks[0].status,status);
 }
 const omittedFields={...check,id:301,status:'queued'};
 delete omittedFields.conclusion;
 delete omittedFields.completed_at;
 const queued=await readPullSignals(42,head,async url=>url.endsWith('/pulls/42')?response(pull):
  url.includes('/reviews?')?response([]):response({total_count:1,check_runs:[omittedFields]}));
 assert.equal(queued.checks[0].conclusion,null);
 assert.equal(queued.checks[0].completedAt,null);
});

test('fails closed when the bounded review or check read throws',async()=>{
 const result=await readPullSignals(42,head,async url=>{
  if(url.endsWith('/pulls/42'))return response(pull);
  throw Error('network unavailable');
 });
 assert.equal(result.reason,'READ_FAILED');
});

test('supports parameterized repository scopes and rejects path-traversal or malformed scopes',async()=>{
 const customRepo={id:9001,full_name:'Jamula/Spellbook'};
 const customScope={repository:'Jamula/Spellbook',repositoryId:9001,branch:'release/v1'};
 const customPull={number:7,base:{repo:customRepo,ref:'release/v1',sha:base},head:{repo:customRepo,sha:head},state:'open',draft:false};
 const customRead=async(url,options)=>{
  assert.equal(options.method,'GET');
  assert.equal(options.signal instanceof AbortSignal,true);
  if(url==='https://api.github.com/repos/Jamula/Spellbook/pulls/7')return response(customPull);
  if(url.includes('/reviews?'))return response([]);
  if(url.includes('/check-runs?'))return response({total_count:0,check_runs:[]});
  throw Error('unexpected '+url);
 };
 const ok=await readPullSignals(7,head,customRead,customScope);
 assert.equal(ok.reason,'PULL_SIGNALS_METADATA_ONLY');
 assert.equal(ok.repositoryId,9001);
 for(const badScope of [
  null,
  {repository:'../bad',repositoryId:9001,branch:'main'},
  {repository:'Jamula/..',repositoryId:9001,branch:'main'},
  {repository:'Jamula/Spellbook',repositoryId:0,branch:'main'},
  {repository:'Jamula/Spellbook',repositoryId:9001,branch:'/main'},
  {repository:'Jamula/Spellbook',repositoryId:9001,branch:'a/../b'}
 ]) {
  assert.equal((await readPullSignals(7,head,customRead,badScope)).reason,'INVALID_SCOPE');
 }
});

test('reads complete exact-head candidate metadata, normalizes rulesets and multi-commit Copilot summaries, and verifies branch health',async()=>{
 const stale='e'.repeat(40);
 const intent={repository:'Jamula/SoftwareFactory',repositoryId:1471342715,branch:'main',number:42,expectedHead:head,expectedBase:base};
 const policyChecks=[
  {name:'build-test',appId:15368},
  {name:'upload-coverage-javascript',appId:15368},
  {name:'windows-aspire-runtime',appId:15368},
  {name:'CodeQL',appId:29110}
 ];
 const candidatePull={...pull,user:{login:'pr-author',id:50},mergeable:true,mergeable_state:'clean'};
 const rules=[
  {type:'deletion'},
  {type:'pull_request',parameters:{required_approving_review_count:0,require_code_owner_review:false,require_last_push_approval:false,required_review_thread_resolution:true,allowed_merge_methods:['squash']}},
  {type:'required_status_checks',parameters:{strict_required_status_checks_policy:true,required_status_checks:[
   {context:'build-test',integration_id:15368},
   {context:'upload-coverage-javascript',integration_id:15368},
   {context:'windows-aspire-runtime',integration_id:15368}
  ]}},
  {type:'code_scanning',parameters:{code_scanning_tools:[{tool:'CodeQL',security_alerts_threshold:'medium_or_higher',alerts_threshold:'errors_and_warnings'}]}}
 ];
 const makeCheck=(id,name,shaValue,appId=15368,slug='github-actions')=>({
  id,name,head_sha:shaValue,status:'completed',conclusion:'success',completed_at:'2026-11-26T19:00:00Z',app:{id:appId,slug}
 });
 const headChecks=[
  makeCheck(1,'build-test',head),
  makeCheck(2,'upload-coverage-javascript',head),
  makeCheck(3,'windows-aspire-runtime',head),
  makeCheck(4,'CodeQL',head,29110,'github-code-scanning')
 ];
 const baseChecks=[
  makeCheck(11,'build-test',base),
  makeCheck(12,'upload-coverage-javascript',base),
  makeCheck(13,'windows-aspire-runtime',base),
  makeCheck(14,'CodeQL',base,29110,'github-code-scanning')
 ];
 const copilotClear='<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\n**No open issues** 🎉';
 const reviews=[
  {id:102,user:{login:'copilot-pull-request-reviewer[bot]',id:175728472},state:'COMMENTED',commit_id:head,submitted_at:'2026-11-26T19:05:00Z',body:copilotClear},
  {id:100,user:{login:'reviewer-one',id:11},state:'APPROVED',commit_id:stale,submitted_at:'2026-11-26T19:01:00Z',body:'old'},
  {id:101,user:{login:'pr-author',id:50},state:'COMMENTED',commit_id:head,submitted_at:'2026-11-26T19:01:00Z'}
 ];
 const candidateFetch=overrides=>async(url,options)=>{
  assert.equal(options.method,'GET');
  assert.equal(options.redirect,'error');
  assert.equal(options.signal instanceof AbortSignal,true);
  if(overrides?.[url])return overrides[url]();
  if(url.endsWith('/pulls/42'))return response(candidatePull);
  if(url.endsWith('/rules/branches/main'))return response(rules);
  if(url.endsWith('/branches/main/protection'))return new Response(JSON.stringify({message:'Branch not protected'}),{status:404});
  if(url.endsWith('/branches/main'))return response({name:'main',protected:true,commit:{sha:base}});
  if(url.includes('/files?'))return response([{filename:'src/component.mjs'}]);
  if(url.includes('/reviews?'))return response(reviews);
  if(url.includes(`/commits/${head}/check-runs`))return response({total_count:headChecks.length,check_runs:headChecks});
  if(url.includes(`/commits/${base}/check-runs`))return response({total_count:baseChecks.length,check_runs:baseChecks});
  throw Error('unexpected '+url);
 };

 const hostedGateReceipt={repository:'Jamula/SoftwareFactory',repositoryId:1471342715,branch:'main',verified:true};
 const noBypassReceipt={repository:'Jamula/SoftwareFactory',repositoryId:1471342715,branch:'main',verified:true,bypass:false};
 const meta=await readCandidatePullMetadata(intent,{
  request:candidateFetch(),policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(meta.evidenceComplete,true);
 assert.equal(meta.liveMerge,false);
 assert.equal(meta.nativeQueue,false);
 assert.equal(meta.protection.bypass,false);
 assert.equal(meta.protection.requiredApprovingReviewCount,0);
 assert.equal(meta.protection.review,false);
 assert.equal(meta.protection.hostedReviewGate,true);
 assert.equal(meta.reviewRecords.length,3);
 assert.deepEqual(meta.reviewRecords.map(r=>r.sequence),[1,2,3]);
 assert.equal(meta.reviewRecords[2].summaryDisposition,'clear');
 assert.equal(JSON.stringify(meta).includes('Approval recommended'),false);

 const missingBypassEvidence=await readCandidatePullMetadata(intent,{
  request:candidateFetch(),policyChecks,hostedReviewGate:hostedGateReceipt
 });
 assert.equal(missingBypassEvidence.protection.bypass,true);

 const missingHostedGateReceipt=await readCandidatePullMetadata(intent,{
  request:candidateFetch(),policyChecks,hostedReviewGate:true,noBypass:noBypassReceipt
 });
 assert.equal(missingHostedGateReceipt.protection.hostedReviewGate,false);

 const inlineZeroBypassActors=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response(
   rules.map(r=>({...r,bypass_actors:[]}))
  )}),
  policyChecks,hostedReviewGate:hostedGateReceipt
 });
 assert.equal(inlineZeroBypassActors.protection.bypass,false);

 const observedBypassActor=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response(
   rules.map(r=>r.type==='pull_request'?{...r,bypass_actors:[{actor_id:1}]}:r)
  )}),
  policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(observedBypassActor.protection.bypass,true);

 let reviewReads=0;
 const changedReviewsMidRead=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/reviews?per_page=100&page=1':()=>response(
   ++reviewReads===1?reviews:[...reviews,{
    id:103,user:{login:'copilot-pull-request-reviewer[bot]',id:175728472},state:'COMMENTED',
    commit_id:head,submitted_at:'2026-11-26T19:06:00Z',
    body:'<!-- ccr-overview-v2 -->\n\n### 🟡 Changes recommended\n\n<summary><strong>1 open issue</strong></summary>'
   }]
  )}),
  policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(changedReviewsMidRead.reason,'PULL_STATE_CHANGED');

 reviewReads=0;
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/reviews?per_page=100&page=1':()=>
   ++reviewReads===1?response(reviews):new Response(null,{status:503})
  }),
  policyChecks
 })).reason,'READ_FAILED');

 reviewReads=0;
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/reviews?per_page=100&page=1':()=>
   ++reviewReads===1?response(reviews):response([{...reviews[0],state:'PENDING',submitted_at:null}])
  }),
  policyChecks
 })).reason,'REVIEW_PENDING');

 const withQueue=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response([...rules,{type:'merge_queue'}])}),
  policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(withQueue.nativeQueue,true);

 assert.equal((await readCandidatePullMetadata(null)).reason,'INTENT_UNKNOWN');
 assert.equal((await readCandidatePullMetadata(intent,{policyChecks:[{name:'',appId:1}]})).reason,'INTENT_UNKNOWN');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42':()=>new Response(null,{status:429})})
 })).reason,'RATE_OR_PERMISSION_UNKNOWN');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42':()=>response({})})
 })).reason,'PULL_IDENTITY_UNKNOWN');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42':()=>response({...candidatePull,head:{...candidatePull.head,sha:stale}})})
 })).reason,'SCOPE_OR_HEAD_CHANGED');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main':()=>response({name:'main',protected:true,commit:{sha:stale}})})
 })).reason,'SCOPE_OR_HEAD_CHANGED');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main':()=>response({})})
 })).reason,'BRANCH_UNKNOWN');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main':()=>new Response(null,{status:502})})
 })).reason,'READ_FAILED');

 for(const badRules of [
  [],
  [null],
  [{type:'pull_request',parameters:{required_approving_review_count:-1}}],
  [{type:'required_status_checks',parameters:{}}],
  [{type:'required_status_checks',parameters:{required_status_checks:[{context:'build-test',integration_id:null}]}}],
  [
   {type:'required_status_checks',parameters:{required_status_checks:[{context:'build-test',integration_id:1}]}},
   {type:'required_status_checks',parameters:{required_status_checks:[{context:'build-test',integration_id:2}]}}
  ],
  [{type:'code_scanning',parameters:{}}]
 ]) {
  assert.equal((await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response(badRules)}),
   policyChecks
  })).reason,'PROTECTIONS_UNVERIFIED');
 }
 const allowMergeMethod=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response([
   {type:'pull_request',parameters:{required_approving_review_count:1,require_code_owner_review:false,require_last_push_approval:false,required_review_thread_resolution:true,allowed_merge_methods:['merge','squash']}},
   rules[2],rules[3]
  ])}),
  policyChecks
 });
 assert.equal(allowMergeMethod.protection.method,'other');
 const nonStringMethod=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response([
   {type:'pull_request',parameters:{required_approving_review_count:1,require_code_owner_review:false,require_last_push_approval:false,allowed_merge_methods:[123]}},
   rules[2]
  ])}),
  policyChecks
 });
 assert.equal(nonStringMethod.protection.method,'other');

 for(const unsupportedRule of [
  [{type:'pull_request',parameters:{required_approving_review_count:1,require_code_owner_review:true,require_last_push_approval:false}},rules[2]],
  [{type:'pull_request',parameters:{required_approving_review_count:1,require_code_owner_review:false,require_last_push_approval:true}},rules[2]]
 ]){
  assert.equal((await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response(unsupportedRule)}),
   policyChecks
  })).reason,'PROTECTIONS_UNVERIFIED');
 }

 for(const badFiles of [
  [],
  [{filename:''}],
  [{filename:'a'},{filename:'a'}],
  [{filename:'src/new.mjs',status:'renamed'}],
  [{filename:'src/same.mjs',status:'renamed',previous_filename:'src/same.mjs'}]
 ]){
  assert.equal((await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/files?per_page=100&page=1':()=>response(badFiles)}),
   policyChecks
  })).reason,'FILES_UNKNOWN');
 }

 const renamedMeta=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/files?per_page=100&page=1':()=>response([
   {filename:'src/component.mjs',status:'renamed',previous_filename:'unowned/legacy.mjs'}
  ])}),
  policyChecks,hostedReviewGate:true
 });
 assert.deepEqual(renamedMeta.paths,['unowned/legacy.mjs','src/component.mjs']);

 const blockedPullMeta=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42':()=>response({...candidatePull,mergeable_state:'blocked'})}),
  policyChecks,hostedReviewGate:true
 });
 assert.equal(blockedPullMeta.baseCompatible,false);

 const reconciledLegacy=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':()=>response({
   enforce_admins:{enabled:true},
   required_status_checks:{strict:true,checks:[{context:'legacy-audit',app_id:15368}]},
   required_pull_request_reviews:{
    required_approving_review_count:2,
    require_code_owner_reviews:false,
    require_last_push_approval:false,
    bypass_pull_request_allowances:{users:[],teams:[],apps:[]}
   },
   required_conversation_resolution:{enabled:true}
  })}),
  policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(reconciledLegacy.protection.requiredApprovingReviewCount,2);
 assert.equal(reconciledLegacy.protection.review,true);
 assert.equal(reconciledLegacy.protection.bypass,false);
 assert.equal(reconciledLegacy.protection.requiredChecks.some(c=>c.name==='legacy-audit'&&c.appId===15368),true);

 const legacyBypassAllowancePresent=await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':()=>response({
   enforce_admins:{enabled:true},
   required_pull_request_reviews:{
    required_approving_review_count:1,
    require_code_owner_reviews:false,
    require_last_push_approval:false,
    bypass_pull_request_allowances:{users:[{login:'bypass-user'}],teams:[],apps:[]}
   }
  })}),
  policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(legacyBypassAllowancePresent.protection.bypass,true);

 const legacyUnknownAllowanceWithoutReceipt=await readCandidatePullMetadata(intent,{
  request:candidateFetch({
   'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response(rules.map(r=>({...r,bypass_actors:[]}))),
   'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':()=>response({
    enforce_admins:{enabled:true},
    required_pull_request_reviews:{
     required_approving_review_count:1,
     require_code_owner_reviews:false,
     require_last_push_approval:false
    }
   })
  }),
  policyChecks,hostedReviewGate:hostedGateReceipt
 });
 assert.equal(legacyUnknownAllowanceWithoutReceipt.protection.bypass,true);

 const legacyBypassWithRulesets=await readCandidatePullMetadata(intent,{
  request:candidateFetch({
   'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':()=>response({
    enforce_admins:{enabled:false},
    required_pull_request_reviews:{
     required_approving_review_count:2,
     require_code_owner_reviews:false,
     require_last_push_approval:false,
     bypass_pull_request_allowances:{users:[],teams:[],apps:[]}
    }
   })
  }),
  policyChecks,hostedReviewGate:hostedGateReceipt,noBypass:noBypassReceipt
 });
 assert.equal(legacyBypassWithRulesets.protection.bypass,true);

 const legacyWithoutAdminEnforcement=await readCandidatePullMetadata(intent,{
  request:candidateFetch({
   'https://api.github.com/repos/Jamula/SoftwareFactory/rules/branches/main':()=>response([]),
   'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':()=>response({
    enforce_admins:{enabled:false},
    required_status_checks:{strict:true,checks:[{context:'build-test',app_id:15368}]},
    required_pull_request_reviews:{
     required_approving_review_count:1,
     require_code_owner_reviews:false,
     require_last_push_approval:false,
     bypass_pull_request_allowances:{users:[],teams:[],apps:[]}
    },
    required_conversation_resolution:{enabled:true}
   })
  }),
  policyChecks
 });
 assert.equal(legacyWithoutAdminEnforcement.protection.bypass,true);

 for(const [legacyResponse,expectedReason] of [
  [()=>new Response(null,{status:403}),'RATE_OR_PERMISSION_UNKNOWN'],
  [()=>new Response(JSON.stringify({message:'Not Found'}),{status:404}),'READ_FAILED'],
  [()=>new Response('x'.repeat(524289),{status:404}),'RESPONSE_LIMIT'],
  [()=>new Response(null,{status:500}),'READ_FAILED'],
  [()=>new Response('x'.repeat(524289),{status:200}),'RESPONSE_LIMIT'],
  [()=>new Response('{}',{status:200,headers:{link:'<next>; rel="next"'}}),'PROTECTIONS_UNVERIFIED'],
  [()=> { throw Error('offline'); },'READ_FAILED']
 ]){
  assert.equal((await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':legacyResponse}),
   policyChecks
  })).reason,expectedReason);
 }

 for(const badLegacy of [
  {},
  {enforce_admins:{enabled:true},allow_force_pushes:{enabled:true}},
  {enforce_admins:{enabled:true},required_status_checks:{contexts:['build-test'],checks:[]}},
  {enforce_admins:{enabled:true},required_status_checks:{checks:[{context:'build-test',app_id:null}]}},
  {enforce_admins:{enabled:true},required_status_checks:{checks:[{context:'build-test',app_id:999}]}},
  {enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:-1}},
  {enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1,require_code_owner_reviews:true,require_last_push_approval:false}},
  {enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1,require_code_owner_reviews:false,require_last_push_approval:true}},
  {enforce_admins:{enabled:true},required_pull_request_reviews:{required_approving_review_count:1,require_code_owner_reviews:false,require_last_push_approval:false,bypass_pull_request_allowances:null}}
 ]){
  assert.equal((await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main/protection':()=>response(badLegacy)}),
   policyChecks
  })).reason,'PROTECTIONS_UNVERIFIED');
 }

 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/reviews?per_page=100&page=1':()=>new Response('[]',{headers:{link:'<next>; rel="next"'}})}),
  policyChecks
 })).reason,'PAGE_LIMIT');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/reviews?per_page=100&page=1':()=>response([{...reviews[0],state:'PENDING',submitted_at:null}])}),
  policyChecks
 })).reason,'REVIEW_PENDING');
 for(const badRev of [[null],[{...reviews[0],state:'UNKNOWN'}]]){
  assert.equal((await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42/reviews?per_page=100&page=1':()=>response(badRev)}),
   policyChecks
  })).reason,'REVIEW_METADATA_UNKNOWN');
 }
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({[`https://api.github.com/repos/Jamula/SoftwareFactory/commits/${head}/check-runs?per_page=100&page=1`]:()=>response({total_count:2,check_runs:[]})}),
  policyChecks
 })).reason,'PAGE_LIMIT');
 assert.equal((await readCandidatePullMetadata(intent,{
  request:candidateFetch({[`https://api.github.com/repos/Jamula/SoftwareFactory/commits/${base}/check-runs?per_page=100&page=1`]:()=>response({total_count:2,check_runs:[]})}),
  policyChecks
 })).reason,'PAGE_LIMIT');

 for(const [finalFactory,expectedReason] of [
  [()=>new Response(null,{status:503}),'READ_FAILED'],
  [()=>response({}),'PULL_IDENTITY_UNKNOWN'],
  [()=>response({...candidatePull,head:{...candidatePull.head,sha:stale}}),'SCOPE_OR_HEAD_CHANGED'],
  [()=>response({...candidatePull,draft:true}),'PULL_STATE_CHANGED']
 ]){
  let pullCount=0;
  const res=await readCandidatePullMetadata(intent,{
   request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/pulls/42':()=>++pullCount===1?response(candidatePull):finalFactory()}),
   policyChecks
  });
  assert.equal(res.reason,expectedReason);
 }

 const mainOk=await readBranchHealth(undefined,policyChecks,{request:candidateFetch()});
 assert.deepEqual(mainOk,{
  shadow:true,liveMerge:false,repository:'Jamula/SoftwareFactory',repositoryId:1471342715,
  branch:'main',head:base,healthy:true,stop:false
 });
 assert.equal((await readBranchHealth(null,policyChecks)).reason,'BRANCH_SCOPE_UNKNOWN');
 assert.equal((await readBranchHealth(undefined,[])).reason,'BRANCH_SCOPE_UNKNOWN');
 assert.equal((await readBranchHealth(undefined,policyChecks,{
  request:async()=>new Response(null,{status:503})
 })).reason,'READ_FAILED');
 assert.equal((await readBranchHealth(undefined,policyChecks,{
  request:async()=>response({})
 })).reason,'BRANCH_UNKNOWN');
 assert.equal((await readBranchHealth(undefined,policyChecks,{
  request:candidateFetch({[`https://api.github.com/repos/Jamula/SoftwareFactory/commits/${base}/check-runs?per_page=100&page=1`]:()=>new Response(null,{status:500})})
 })).reason,'READ_FAILED');
 assert.equal((await readBranchHealth(undefined,policyChecks,{
  request:candidateFetch({[`https://api.github.com/repos/Jamula/SoftwareFactory/commits/${base}/check-runs?per_page=100&page=1`]:()=>response({total_count:2,check_runs:[]})})
 })).reason,'PAGE_LIMIT');
 let branchReads=0;
 assert.equal((await readBranchHealth(undefined,policyChecks,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main':()=>++branchReads===1?response({name:'main',protected:true,commit:{sha:base}}):new Response(null,{status:500})})
 })).reason,'READ_FAILED');
 branchReads=0;
 assert.equal((await readBranchHealth(undefined,policyChecks,{
  request:candidateFetch({'https://api.github.com/repos/Jamula/SoftwareFactory/branches/main':()=>response({name:'main',protected:true,commit:{sha:++branchReads===1?base:stale}})})
 })).reason,'BRANCH_CHANGED');
 const failedMain=await readBranchHealth(undefined,policyChecks,{
  request:candidateFetch({[`https://api.github.com/repos/Jamula/SoftwareFactory/commits/${base}/check-runs?per_page=100&page=1`]:()=>response({
   total_count:baseChecks.length,
   check_runs:baseChecks.map((c,i)=>i===0?{...c,conclusion:'failure'}:c)
  })})
 });
 assert.equal(failedMain.healthy,false);
 const orderEvents=[];
 const orderedMain=await readBranchHealth(undefined,policyChecks,{
  request:async(url,options)=>{
   if(url.endsWith('/branches/main')){
    orderEvents.push(`branch-${orderEvents.filter(e=>e.startsWith('branch-')).length+1}`);
    return response({name:'main',protected:true,commit:{sha:base}});
   }
   await new Promise(resolve=>setTimeout(resolve,5));
   orderEvents.push('checks');
   return candidateFetch()(url,options);
  }
 });
 assert.equal(orderedMain.healthy,true);
 assert.deepEqual(orderEvents,['branch-1','checks','branch-2']);
});
