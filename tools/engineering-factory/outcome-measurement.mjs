// Offline measurement only. Inputs must come from a separately trusted evidence
// adapter; this function neither grants authority nor infers issue acceptance.
const id=n=>Number.isSafeInteger(n)&&n>0;
const time=n=>Number.isSafeInteger(n)&&n>=0;
const sha=s=>typeof s==='string'&&/^[a-f0-9]{40}$/.test(s);
const unknown=reason=>({known:false,reason});
export function measureIssueOutcome(issue,pulls){
  if(!issue||!id(issue.repositoryId)||!id(issue.number)||!Array.isArray(pulls))
    return unknown('INVALID_INPUT');
  if(issue.state!=='closed'||issue.acceptanceVerified!==true)
    return unknown('ACCEPTANCE_UNVERIFIED');
  if(!time(issue.readyAt)||!time(issue.acceptedAt)||issue.acceptedAt<issue.readyAt)
    return unknown('TIMESTAMPS_UNKNOWN');
  if(issue.lastReopenedAt!==null&&(!time(issue.lastReopenedAt)||issue.lastReopenedAt>=issue.acceptedAt))
    return unknown('REOPENED_OR_UNKNOWN');
  const required=issue.requiredPullNumbers;
  if(!Array.isArray(required)||required.length===0||required.some(n=>!id(n))||new Set(required).size!==required.length)
    return unknown('LINKS_UNKNOWN');
  let latestMain=0;
  for(const number of required){
    const matches=pulls.filter(p=>p?.repositoryId===issue.repositoryId&&p.number===number);
    if(matches.length!==1)return unknown('PULL_UNKNOWN_OR_DUPLICATE');
    const p=matches[0];
    if(!Array.isArray(p.issueNumbers)||p.issueNumbers.filter(n=>n===issue.number).length!==1)
      return unknown('LINK_UNVERIFIED');
    if(p.merged!==true||!sha(p.mergeSha)||p.mainVerifiedSha!==p.mergeSha||p.mainVerified!==true)
      return unknown('MAIN_UNVERIFIED');
    if(!time(p.mergedAt)||!time(p.mainVerifiedAt)||p.mainVerifiedAt<p.mergedAt||p.mainVerifiedAt>issue.acceptedAt)
      return unknown('PULL_TIMESTAMPS_UNKNOWN');
    latestMain=Math.max(latestMain,p.mainVerifiedAt);
  }
  return {known:true,reason:'VERIFIED_OUTCOME',elapsedMs:issue.acceptedAt-issue.readyAt,
    mainVerifiedAt:latestMain,requiredPullCount:required.length};
}
