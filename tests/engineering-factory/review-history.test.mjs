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

test('newer stale approval supersedes only previous approval, not objections',()=>{
  assert.deepEqual(normalize(head,[r(1,'APPROVED'),r(2,'APPROVED',stale)]).reviews,[]);
  assert.equal(normalize(head,[r(1,'DISMISSED'),r(2,'APPROVED',stale)]).reviews[0].state,'DISMISSED');
  assert.equal(normalize(head,[r(1,'APPROVED'),r(2,'APPROVED',stale),r(3,'APPROVED')]).reviews[0].state,'APPROVED');
  assert.equal(normalize(head,[r(1,'APPROVED',head,'other'),r(2,'APPROVED'),r(3,'APPROVED',stale)]).reviews[0].reviewer,'other');
});

test('factory-only Copilot comments preserve prior objections and exact head',()=>{
 const bot='copilot-pull-request-reviewer[bot]',repo='Jamula/SoftwareFactory';
 const c=(sequence,state,commit=head)=>({...r(sequence,state,commit,bot),...(state==='COMMENTED'?{summaryDisposition:'clear'}:{})});
 const norm=(entries,repository=repo)=>normalize(head,entries,repository);
 assert.deepEqual(norm([c(1,'COMMENTED')]).reviews,[{reviewer:bot,head,state:'COMMENTED',summaryDisposition:'clear'}]);
 assert.equal(norm([c(1,'COMMENTED')],'other/repo').ok,false);
 assert.deepEqual(norm([r(1,'COMMENTED')]).reviews,[]);
 assert.deepEqual(norm([c(1,'COMMENTED',stale)]).reviews,[]);
 assert.deepEqual(norm([c(1,'COMMENTED'),c(2,'COMMENTED',stale)]).reviews,[]);
 for(const state of ['CHANGES_REQUESTED','DISMISSED','APPROVED'])
   assert.equal(norm([c(1,state),c(2,'COMMENTED')]).reviews[0].state,state);
 assert.equal(norm([c(1,'COMMENTED'),c(2,'CHANGES_REQUESTED')]).reviews[0].state,'CHANGES_REQUESTED');
 assert.deepEqual(norm([c(1,'COMMENTED'),c(2,'APPROVED',stale)]).reviews,[]);
 assert.equal(norm([r(1,'COMMENTED',head,'copilot-pull-request-reviewer')]).reviews[0].state,'COMMENTED');
 assert.deepEqual(normalize(head,[r(1,'COMMENTED',head,'copilot-pull-request-reviewer')]).reviews,[]);
});

test('latest current-head summary must be independently dispositioned; missing stays uncertain',()=>{
 const repo='Jamula/SoftwareFactory',bot='copilot-pull-request-reviewer[bot]';
 const c=(sequence,summaryDisposition)=>({...r(sequence,'COMMENTED',head,bot),summaryDisposition});
 for(const v of [undefined,'bad','uncertain','actionable','clear'])assert.equal(normalize(head,[c(1,'clear'),c(2,v)],repo).reviews[0].summaryDisposition,['actionable','clear'].includes(v)?v:'uncertain');
});

test('current-head non-clear Copilot summary supersedes earlier approval but never an objection',()=>{
 const repo='Jamula/SoftwareFactory',bot='copilot-pull-request-reviewer[bot]';
 for(const summaryDisposition of [undefined,'uncertain','actionable','bad']) {
  const comment={...r(2,'COMMENTED',head,bot),summaryDisposition};
  const result=normalize(head,[r(1,'APPROVED',head,bot),comment],repo).reviews[0];
  assert.equal(result.state,'COMMENTED');assert.notEqual(result.summaryDisposition,'clear');
  for(const state of ['CHANGES_REQUESTED','DISMISSED'])assert.equal(normalize(head,[r(1,state,head,bot),comment],repo).reviews[0].state,state);
 }
});

test('stale reviews never remove a current-head non-clear summary when another reviewer approved',()=>{
 const repo='Jamula/SoftwareFactory',bot='copilot-pull-request-reviewer[bot]';
 for(const summaryDisposition of [undefined,'uncertain','actionable'])for(const state of ['COMMENTED','APPROVED']){
  const result=normalize(head,[{...r(1,'COMMENTED',head,bot),summaryDisposition},r(2,'APPROVED',head,'Other'),r(3,state,stale,bot)],repo);
  assert.equal(result.reviews.length,2);assert.equal(result.reviews.find(v=>v.reviewer===bot).state,'COMMENTED');assert.notEqual(result.reviews.find(v=>v.reviewer===bot).summaryDisposition,'clear');
 }
});
