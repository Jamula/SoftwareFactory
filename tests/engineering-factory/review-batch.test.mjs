import test from 'node:test';
import assert from 'node:assert/strict';
import {planReviewBatch} from '../../tools/engineering-factory/review-batch.mjs';
const head='a'.repeat(40);
const inv=(change={})=>({head,complete:true,independent:true,summaryDisposition:'clear',findings:[],...change});
const finding=(id,state='actionable',source='inline')=>({id,state,source});
test('batches every current actionable finding once, including summary-only findings',()=>{
  assert.deepEqual(planReviewBatch(head,inv({summaryDisposition:'actionable',findings:[
    finding('b'),finding('a','actionable','summary'),finding('b','actionable','summary'),finding('c','resolved')
  ]})),{state:'repair',reason:'BATCH_ALL_CURRENT_FINDINGS',repairIds:['a','b']});
  assert.deepEqual(planReviewBatch(head,inv()),{state:'no-repair',reason:'NO_ACTIONABLE_FINDINGS_REPORTED',repairIds:[]});
  assert.equal(planReviewBatch(head,inv({findings:[finding('a')]})).state,'repair');
});
test('zero threads does not establish summary clearance or review authority',()=>{
  for(const change of [{summaryDisposition:'uncertain'},{summaryDisposition:'actionable'}])
    assert.equal(planReviewBatch(head,inv(change)).reason,'SUMMARY_NEEDS_ASSESSMENT');
  assert.equal(planReviewBatch(head,inv({summaryDisposition:'other'})).reason,'SUMMARY_UNKNOWN');
  for(const input of [null,inv({head:'b'.repeat(40)}),inv({complete:false}),inv({independent:false})])
    assert.equal(planReviewBatch(head,input).reason,'REVIEW_EVIDENCE_UNKNOWN');
  assert.equal(planReviewBatch('bad',inv()).reason,'REVIEW_EVIDENCE_UNKNOWN');
});
test('rejects malformed, oversized, sparse or conflicting inventories',()=>{
  for(const findings of [null,Array(257).fill(finding('a')),Array(1),[null],[finding('!')],[finding('a','unknown')],[finding('a','actionable','untrusted')]])
    assert.equal(planReviewBatch(head,inv({findings})).reason,'FINDINGS_UNKNOWN');
  assert.equal(planReviewBatch(head,inv({findings:[finding('a'),finding('a','resolved')]})).reason,'CONFLICTING_FINDINGS');
});
