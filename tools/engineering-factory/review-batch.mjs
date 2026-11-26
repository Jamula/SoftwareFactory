// Advisory, metadata-only repair planning. The trusted adapter must include
// formal review summaries and inline findings, not just unresolved threads.
// No output authorizes review, merge, dispatch or a change to repository policy.
const sha=v=>typeof v==='string'&&/^[a-f0-9]{40}$/.test(v);
const token=v=>typeof v==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v);
const unknown=reason=>({state:'unknown',reason,repairIds:[]});
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
