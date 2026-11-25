import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeReviewHistory as normalize} from '../../tools/engineering-factory/review-history.mjs';
const head='a'.repeat(40), stale='b'.repeat(40);
const r=(sequence,state,commit=head,reviewer='Reviewer')=>({sequence,state,head:commit,reviewer});
test('current approval normalizes identity',()=>assert.deepEqual(normalize(head,[r(1,'APPROVED')]).reviews,[{reviewer:'reviewer',head,state:'APPROVED'}]));
test('comments and stale approval cannot clear objections',()=>{
  assert.equal(normalize(head,[r(1,'CHANGES_REQUESTED',stale),r(2,'COMMENTED'),r(3,'APPROVED',stale)]).reviews[0].state,'CHANGES_REQUESTED');
  assert.equal(normalize(head,[r(1,'CHANGES_REQUESTED'),r(2,'APPROVED')]).reviews[0].state,'APPROVED');
});
test('dismissal blocks; stale approvals alone do not qualify',()=>{
  assert.equal(normalize(head,[r(1,'APPROVED'),r(2,'DISMISSED')]).reviews[0].state,'DISMISSED');
  assert.deepEqual(normalize(head,[r(1,'APPROVED',stale)]).reviews,[]);
});
test('reject malformed or ambiguous evidence',()=>{
  for(const [h,entries] of [[null,[]],[head,null],[head,new Array(1)],[head,[null]],[head,[{}]],[head,[r(2,'APPROVED'),r(1,'APPROVED')]],[head,[r(1,'UNKNOWN')]],[head,[r(1,'APPROVED','bad')]],[head,[r(1,'APPROVED',head,'bad name')]],[head,[r(1,'APPROVED',head,null)]],[head,[r(1.5,'APPROVED')]]]) assert.equal(normalize(h,entries).ok,false);
});
test('empty history grants no approval and distinct reviewers remain distinct',()=>{
  assert.deepEqual(normalize(head,[]).reviews,[]);
  assert.equal(normalize(head,[r(1,'APPROVED'),r(2,'CHANGES_REQUESTED',head,'other')]).reviews.length,2);
});
