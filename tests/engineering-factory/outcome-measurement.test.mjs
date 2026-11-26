import test from 'node:test';
import assert from 'node:assert/strict';
import {measureIssueOutcome} from '../../tools/engineering-factory/outcome-measurement.mjs';
const h='a'.repeat(40);
const issue=()=>({repositoryId:1,number:9,state:'closed',acceptanceVerified:true,readyAt:100,acceptedAt:500,lastReopenedAt:null,requiredPullNumbers:[81,82]});
const pull=(number,at=300)=>({repositoryId:1,number,issueNumbers:[9,10],merged:true,mergeSha:h,mainVerifiedSha:h,mainVerified:true,mergedAt:200,mainVerifiedAt:at});
const pulls=()=>[pull(81),pull(82,400)];
test('counts one accepted outcome with multiple explicit PR links and exact merge-head main verification',()=>{
  assert.deepEqual(measureIssueOutcome(issue(),pulls()),{known:true,reason:'VERIFIED_OUTCOME',elapsedMs:400,mainVerifiedAt:400,requiredPullCount:2});
  assert.equal(measureIssueOutcome({...issue(),lastReopenedAt:150},pulls()).known,true);
  assert.equal(measureIssueOutcome(issue(),[...pulls(),{...pull(81),repositoryId:2},null]).known,true);
});
test('unknown or contradictory issue evidence is never converted to zero duration',()=>{
  for(const [value,reason] of [
    [null,'INVALID_INPUT'],[{...issue(),repositoryId:0},'INVALID_INPUT'],[{...issue(),number:0},'INVALID_INPUT'],
    [{...issue(),state:'open'},'ACCEPTANCE_UNVERIFIED'],[{...issue(),acceptanceVerified:false},'ACCEPTANCE_UNVERIFIED'],
    [{...issue(),readyAt:null},'TIMESTAMPS_UNKNOWN'],[{...issue(),acceptedAt:null},'TIMESTAMPS_UNKNOWN'],[{...issue(),acceptedAt:99},'TIMESTAMPS_UNKNOWN'],
    [{...issue(),lastReopenedAt:undefined},'REOPENED_OR_UNKNOWN'],[{...issue(),lastReopenedAt:500},'REOPENED_OR_UNKNOWN'],
    ...[null,[],[0],[81,81],Array(1),[81,,82],Array(251).fill(81)].map(requiredPullNumbers=>[{...issue(),requiredPullNumbers},'LINKS_UNKNOWN'])
  ])assert.deepEqual(measureIssueOutcome(value,pulls()),{known:false,reason});
  assert.equal(measureIssueOutcome(issue(),null).reason,'INVALID_INPUT');
});
test('partial, duplicated, unlinked, stale-main or invalid PR evidence fails closed',()=>{
  const cases=[
    [[], 'PULL_UNKNOWN_OR_DUPLICATE'],[[pull(81),pull(81),pull(82)],'PULL_UNKNOWN_OR_DUPLICATE'],
    ...[null,[10],[9,9]].map(issueNumbers=>[[{...pull(81),issueNumbers},pull(82)],'LINK_UNVERIFIED']),
    ...[{merged:false},{mergeSha:null},{mergeSha:'invalid'},{mainVerifiedSha:'b'.repeat(40)},{mainVerified:false}].map(change=>[[{...pull(81),...change},pull(82)],'MAIN_UNVERIFIED']),
    ...[{mergedAt:null},{mainVerifiedAt:null},{mainVerifiedAt:199},{mainVerifiedAt:501}].map(change=>[[{...pull(81),...change},pull(82)],'PULL_TIMESTAMPS_UNKNOWN'])
  ];
  for(const [p,reason] of cases)assert.deepEqual(measureIssueOutcome(issue(),p),{known:false,reason});
});

test('main verification timestamp comes only from PR evidence even when readiness is later',()=>{
  assert.deepEqual(measureIssueOutcome({...issue(),readyAt:450},pulls()),{known:true,reason:'VERIFIED_OUTCOME',elapsedMs:50,mainVerifiedAt:400,requiredPullCount:2});
});
