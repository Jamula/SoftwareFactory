import test from 'node:test';
import assert from 'node:assert/strict';
import {buildCandidateReviewEvidence, normalizeReviewHistory as normalize} from '../../tools/engineering-factory/review-history.mjs';
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

test('builds candidate review evidence enforcing independence, pending blocks and summary-only findings',()=>{
 const bot='copilot-pull-request-reviewer[bot]';
 const baseOpts={reviewers:[bot,'reviewer','author','agent'],author:'author',agent:'agent'};

 const clear=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'clear',summaryFindings:[]}
 ],baseOpts);
 assert.equal(clear.ok,true);
 assert.equal(clear.independentFavorable,true);
 assert.equal(clear.batch.state,'no-repair');

 const summaryOnly=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'actionable',
   summaryFindings:[{id:'summary-10-1',state:'actionable',source:'summary'}]}
 ],baseOpts);
 assert.equal(summaryOnly.ok,true);
 assert.equal(summaryOnly.independentFavorable,false);
 assert.deepEqual(summaryOnly.batch,{state:'repair',reason:'BATCH_ALL_CURRENT_FINDINGS',repairIds:['summary-10-1']});

 const uncertain=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:bot,head,state:'COMMENTED'}
 ],baseOpts);
 assert.equal(uncertain.independentFavorable,false);
 assert.equal(uncertain.platformReview.summaryDisposition,'uncertain');

 for(const actor of ['author','agent']){
  const selfApproved=buildCandidateReviewEvidence(head,[r(1,'APPROVED',head,actor)],baseOpts);
  assert.equal(selfApproved.independentFavorable,false);
  assert.equal(selfApproved.platformReview.independent,false);
 }

 const consumerApproved=buildCandidateReviewEvidence(head,[r(1,'APPROVED',head,'reviewer')],
  {...baseOpts,repository:'Jamula/Spellbook',inlineFindings:[{id:'inline-1',state:'resolved',source:'inline'}]});
 assert.equal(consumerApproved.independentFavorable,true);
 assert.equal(consumerApproved.platformReview.summaryDisposition,'clear');

 const withActionableInline=buildCandidateReviewEvidence(head,[r(1,'APPROVED',head,'reviewer')],
  {...baseOpts,repository:'Jamula/Spellbook',inlineFindings:[{id:'inline-1',state:'actionable',source:'inline'}]});
 assert.equal(withActionableInline.independentFavorable,false);
 assert.equal(withActionableInline.platformReview.summaryDisposition,'actionable');

 for(const copilotLogin of [bot,'copilot-pull-request-reviewer']){
  const consumerWithSummary=buildCandidateReviewEvidence(head,[
   {sequence:1,reviewer:copilotLogin,head,state:'COMMENTED',summaryDisposition:'actionable',
    summaryFindings:[{id:'summary-99-1',state:'actionable',source:'summary'}]},
   r(2,'APPROVED',head,'reviewer')
  ],{...baseOpts,repository:'Jamula/Spellbook'});
  assert.equal(consumerWithSummary.ok,true);
  assert.equal(consumerWithSummary.independentFavorable,false);
  assert.equal(consumerWithSummary.platformReview.summaryDisposition,'actionable');
  assert.deepEqual(consumerWithSummary.batch.repairIds,['summary-99-1']);
 }

 const consumerUncertainCopilot=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'uncertain',summaryFindings:[]},
  r(2,'APPROVED',head,'reviewer')
 ],{...baseOpts,repository:'Jamula/Spellbook'});
 assert.equal(consumerUncertainCopilot.independentFavorable,false);
 assert.equal(consumerUncertainCopilot.platformReview.summaryDisposition,'uncertain');

 const consumerClearCopilot=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'clear',summaryFindings:[]},
  {sequence:2,reviewer:bot,head:stale,state:'COMMENTED',summaryDisposition:'clear'},
  {sequence:3,reviewer:'copilot-pull-request-reviewer',head,state:'COMMENTED',summaryDisposition:'clear',summaryFindings:[]},
  {sequence:4,reviewer:'copilot-pull-request-reviewer',head,state:'APPROVED'},
  r(5,'APPROVED',head,'reviewer')
 ],{...baseOpts,repository:'Jamula/Spellbook'});
 assert.equal(consumerClearCopilot.independentFavorable,true);

 assert.equal(buildCandidateReviewEvidence(head,[{...r(1,'APPROVED'),state:'PENDING'}],baseOpts).reason,'REVIEW_PENDING');

 const withInfoBotComment=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:'github-code-quality[bot]',head:stale,state:'COMMENTED'},
  {sequence:2,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'clear',summaryFindings:[]},
  {sequence:3,reviewer:'github-code-quality[bot]',head,state:'COMMENTED'}
 ],baseOpts);
 assert.equal(withInfoBotComment.ok,true);
 assert.equal(withInfoBotComment.independentFavorable,true);

 const onlyInfoBotComment=buildCandidateReviewEvidence(head,[
  {sequence:1,reviewer:'github-code-quality[bot]',head,state:'COMMENTED'}
 ],{...baseOpts,reviewers:[bot,'github-code-quality[bot]']});
 assert.equal(onlyInfoBotComment.ok,true);
 assert.equal(onlyInfoBotComment.independentFavorable,false);
 assert.equal(onlyInfoBotComment.platformReview.independent,false);

 for(const adverseState of ['CHANGES_REQUESTED','DISMISSED','APPROVED']){
  assert.equal(buildCandidateReviewEvidence(head,[
   {sequence:1,reviewer:'github-code-quality[bot]',head,state:adverseState}
  ],baseOpts).ok,false);
 }

 const longRepo=`${'o'.repeat(39)}/${'r'.repeat(100)}`;
 assert.equal(longRepo.length,140);
 const maxRepoApproved=buildCandidateReviewEvidence(head,[r(1,'APPROVED',head,'reviewer')],
  {...baseOpts,repository:longRepo});
 assert.equal(maxRepoApproved.ok,true);
 assert.equal(maxRepoApproved.independentFavorable,true);

 const tamperedInline=[{id:'inline-tampered',state:'actionable',source:'inline'}];
 Object.defineProperty(tamperedInline,'map',{value:()=>[]});
 const symbolHistory=[r(1,'APPROVED',head,'reviewer')];
 symbolHistory[Symbol.iterator]=function*(){};

 const inheritedRepo=Object.assign(Object.create({repository:'Jamula/Spellbook'}),baseOpts);
 const getterInline={...baseOpts};
 Object.defineProperty(getterInline,'inlineFindings',{get(){throw Error('getter');}});
 const badDispEntry={...r(1,'APPROVED'),summaryDisposition:'untrusted-payload'};
 for(const [h,hist,opts] of [
  ['bad',[],baseOpts],
  [head,null,baseOpts],
  [head,symbolHistory,baseOpts],
  [head,[],null],
  [head,[],inheritedRepo],
  [head,[],getterInline],
  [head,[],{...baseOpts,inlineFindings:tamperedInline}],
  [head,[badDispEntry],baseOpts],
  [head,[],{...baseOpts,reviewers:[]}],
  [head,[],{...baseOpts,repository:''}],
  [head,[],{...baseOpts,inlineFindings:[{id:'x',state:'actionable',source:'summary'}]}],
  [head,[null],baseOpts],
  [head,[{sequence:1,reviewer:bot,head,state:'COMMENTED',summaryFindings:[{id:'x',state:'actionable',source:'inline'}]}],baseOpts],
  [head,[{sequence:NaN,reviewer:bot,head,state:'COMMENTED'}],{...baseOpts,repository:'Jamula/Spellbook'}],
  [head,[
   {sequence:2,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'actionable',
    summaryFindings:[{id:'summary-2-1',state:'actionable',source:'summary'}]},
   {sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'clear',summaryFindings:[]},
   r(3,'APPROVED',head,'reviewer')
  ],{...baseOpts,repository:'Jamula/Spellbook'}],
  [head,[r(2,'APPROVED'),r(1,'APPROVED')],baseOpts],
  [head,[{sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'actionable',
   summaryFindings:Array.from({length:10},(_,i)=>({id:`s-${i}`,state:'actionable',source:'summary'}))}
  ],{...baseOpts,inlineFindings:Array.from({length:250},(_,i)=>({id:`i-${i}`,state:'resolved',source:'inline'}))}],
  [head,[{sequence:1,reviewer:bot,head,state:'COMMENTED',summaryDisposition:'actionable',
   summaryFindings:[{id:'dup',state:'actionable',source:'summary'}]}
  ],{...baseOpts,inlineFindings:[{id:'dup',state:'resolved',source:'inline'}]}]
 ]) {
  assert.equal(buildCandidateReviewEvidence(h,hist,opts).ok,false);
 }
});
