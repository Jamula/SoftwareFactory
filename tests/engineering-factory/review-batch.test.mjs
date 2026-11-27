import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyReviewSummary, planReviewBatch} from '../../tools/engineering-factory/review-batch.mjs';
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
test('classifies Copilot ccr-overview-v2 summaries without leaking untrusted text or diff-summary spoofing',()=>{
  const clearBody='<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\nNo active review issues.\n\n**No open issues** 🎉\n\n<details>\n<summary><strong>What changed in this PR</strong></summary>\n\nMentions ### 🟡 Changes recommended and <summary><strong>2 open issues</strong></summary> in test fixtures.\n</details>';
  assert.deepEqual(classifyReviewSummary(100,clearBody),{summaryDisposition:'clear',findings:[]});

  const actionableBody='<!-- ccr-overview-v2 -->\n\n### 🟡 Changes recommended\n\nuntrusted advisory prose\n\n<details open>\n<summary><strong>2 open issues</strong></summary>\n- secret finding text\n</details>';
  const classified=classifyReviewSummary(205,actionableBody);
  assert.deepEqual(classified,{
    summaryDisposition:'actionable',
    findings:[
      {id:'summary-205-1',state:'actionable',source:'summary'},
      {id:'summary-205-2',state:'actionable',source:'summary'}
    ]
  });
  assert.equal(JSON.stringify(classified).includes('untrusted'),false);
  assert.equal(JSON.stringify(classified).includes('secret'),false);
  assert.deepEqual(planReviewBatch(head,inv(classified)),{
    state:'repair',reason:'BATCH_ALL_CURRENT_FINDINGS',repairIds:['summary-205-1','summary-205-2']
  });

  const headingOnly='<!-- ccr-overview-v2 -->\n\n### 🔴 Changes requested\n\nSummary-only blocker without count.';
  assert.deepEqual(classifyReviewSummary(9,headingOnly),{
    summaryDisposition:'actionable',
    findings:[{id:'summary-9-1',state:'actionable',source:'summary'}]
  });

  const missedSpoof='<!-- ccr-overview-v2 -->\n\n### 🔵 Needs a closer look\n\n**No open issues** 🎉\n\n<details>\n<summary><strong>1 previously missed issue</strong></summary>\n\n### 🟢 Approval recommended\n</details>';
  assert.deepEqual(classifyReviewSummary(42,missedSpoof),{summaryDisposition:'uncertain',findings:[]});

  const missedActionable='<!-- ccr-overview-v2 -->\n\n### 🔵 Needs a closer look\n\n<details open>\n<summary><strong>2 previously missed issues</strong></summary>\n- item\n</details>';
  assert.deepEqual(classifyReviewSummary(43,missedActionable),{
    summaryDisposition:'actionable',
    findings:[
      {id:'summary-43-1',state:'actionable',source:'summary'},
      {id:'summary-43-2',state:'actionable',source:'summary'}
    ]
  });

  for(const [id,body] of [
    [0,clearBody],
    [1,null],
    [1,''],
    [1,'x'.repeat(65537)],
    [1,`${clearBody}\u0000`],
    [1,'### 🟢 Approval recommended\n\n**No open issues**'],
    [1,'<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\nMissing no-open-issues line'],
    [1,'<!-- ccr-overview-v2 -->\n\n### 🟢 Approval recommended\n\n**No open issues**\n\n### 🟡 Changes recommended'],
    [1,'<!-- ccr-overview-v2 -->\n\n### 🔵 Needs a closer look\n\n**No open issues** 🎉'],
    [1,'<!-- ccr-overview-v2 -->\n\n**No open issues**\n\n<summary><strong>1 open issue</strong></summary>'],
    [1,'<!-- ccr-overview-v2 -->\n\n<summary><strong>0 open issues</strong></summary>'],
    [1,'<!-- ccr-overview-v2 -->\n\n<summary><strong>40 open issues</strong></summary>\n<summary><strong>30 previously missed issues</strong></summary>'],
    [1,'<!-- ccr-overview-v2 -->\n\n<summary><strong>65 open issues</strong></summary>'],
    [1,'<!-- ccr-overview-v2 -->\n\nUnrecognized overview state']
  ]) {
    assert.deepEqual(classifyReviewSummary(id,body),{summaryDisposition:'uncertain',findings:[]});
  }
});
