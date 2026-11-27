// Advisory, metadata-only repair planning. The trusted adapter must include
// formal review summaries and inline findings, not just unresolved threads.
// No output authorizes review, merge, dispatch or a change to repository policy.
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const positive=v=>Number.isSafeInteger(v)&&v>0;
const unknown=reason=>({state:'unknown',reason,repairIds:[]});
const uncertainSummary=()=>({summaryDisposition:'uncertain',findings:[]});

export function classifyReviewSummary(reviewId,body){
  if(!positive(reviewId)||typeof body!=='string'||body.length===0||body.length>65536||body.includes('\u0000'))
    return uncertainSummary();
  const detailsIndex=body.search(/<details>\s*<summary><strong>What changed in this PR<\/strong><\/summary>/);
  const overview=(detailsIndex>=0?body.slice(0,detailsIndex):body).trimStart();
  if(!overview.startsWith('<!-- ccr-overview-v2 -->'))return uncertainSummary();
  const clearHeading=/^<!-- ccr-overview-v2 -->\r?\n+### (?:🟢 )?Approval recommended\r?\n/.test(overview);
  const needsLookHeading=/^### (?:🔵 )?Needs a closer look\s*$/m.test(overview);
  const noOpenIssues=/^\*\*No open issues\*\*(?: 🎉)?\s*$/m.test(overview);
  const changesHeading=/^### (?:🟡 |🔴 )?Changes (?:recommended|requested)\s*$/m.test(overview);
  const openMatch=/<summary><strong>(\d{1,3}) open issues?<\/strong><\/summary>/.exec(overview);
  const missedMatch=/<summary><strong>(\d{1,3}) previously missed issues?<\/strong><\/summary>/.exec(overview);
  const hasIssueSummary=openMatch!==null||missedMatch!==null;
  if((clearHeading||noOpenIssues)&&(changesHeading||needsLookHeading||hasIssueSummary))return uncertainSummary();
  if(clearHeading&&noOpenIssues&&!overview.includes('<details'))return {summaryDisposition:'clear',findings:[]};
  if(!changesHeading&&!hasIssueSummary)return uncertainSummary();
  let count=0;
  for(const match of [openMatch,missedMatch]){
    if(match===null)continue;
    const parsed=Number(match[1]);
    if(parsed<1||parsed>64)return uncertainSummary();
    count+=parsed;
  }
  if(count===0)count=1;
  if(count>64)return uncertainSummary();
  return {
    summaryDisposition:'actionable',
    findings:Array.from({length:count},(_,index)=>({
      id:`summary-${reviewId}-${index+1}`,state:'actionable',source:'summary'
    }))
  };
}

export function planReviewBatch(candidate,inventory){
  if(!sha(candidate)||!inventory||inventory.head!==candidate||inventory.complete!==true||inventory.independent!==true)
    return unknown('REVIEW_EVIDENCE_UNKNOWN');
  if(!['clear','actionable','uncertain'].includes(inventory.summaryDisposition))
    return unknown('SUMMARY_UNKNOWN');
  if(!Array.isArray(inventory.findings)||inventory.findings.length>256)
    return unknown('FINDINGS_UNKNOWN');
  const byId=new Map();
  for(const finding of inventory.findings){
    if(!finding||!token(finding.id)||!['actionable','resolved'].includes(finding.state)||
        !['inline','summary'].includes(finding.source))
      return unknown('FINDINGS_UNKNOWN');
    const prior=byId.get(finding.id);
    if(prior!==undefined&&prior!==finding.state)return unknown('CONFLICTING_FINDINGS');
    byId.set(finding.id,finding.state);
  }
  const repairIds=[...byId].filter(([,state])=>state==='actionable').map(([id])=>id).sort();
  if(inventory.summaryDisposition==='uncertain'||(inventory.summaryDisposition==='actionable'&&!repairIds.length))
    return unknown('SUMMARY_NEEDS_ASSESSMENT');
  if(repairIds.length)return {state:'repair',reason:'BATCH_ALL_CURRENT_FINDINGS',repairIds};
  return {state:'no-repair',reason:'NO_ACTIONABLE_FINDINGS_REPORTED',repairIds:[]};
}
