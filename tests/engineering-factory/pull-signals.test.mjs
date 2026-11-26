import test from 'node:test';
import assert from 'node:assert/strict';
import {readPullSignals} from '../../tools/engineering-factory/pull-signals.mjs';

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
