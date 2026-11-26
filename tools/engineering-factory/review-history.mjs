// Pure normalization only. A trusted adapter must establish completeness,
// chronological order, and reviewer identity before calling this function.
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const dense = a => Array.isArray(a) && Object.keys(a).length === a.length &&
  Array.from({length:a.length}, (_,i) => Object.hasOwn(a,i)).every(Boolean);
const invalid = () => ({ok:false, reviews:[], reason:'AMBIGUOUS_REVIEW_HISTORY'});
const copilot = r => ['copilot-pull-request-reviewer','copilot-pull-request-reviewer[bot]'].includes(r.toLowerCase());
export function normalizeReviewHistory(head, history, repository) {
  const factory = typeof repository === 'string' && repository.toLowerCase() === 'jamula/softwarefactory';
  if (!sha(head) || !dense(history)) return invalid();
  const byReviewer = new Map();
  let lastSequence = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object' ||
        !Number.isSafeInteger(entry.sequence) || entry.sequence <= lastSequence ||
        typeof entry.reviewer !== 'string' || (!/^[a-z0-9][a-z0-9-]*$/i.test(entry.reviewer) && !(factory && copilot(entry.reviewer))) ||
        !sha(entry.head) ||
        !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(entry.state)) return invalid();
    lastSequence = entry.sequence;
    const reviewer = entry.reviewer.toLowerCase();
    // Only a factory-scoped, trusted Copilot review comment is a candidate.
    // Preserve blocking reviews; a comment cannot overturn them.
    if (entry.state === 'COMMENTED') {
      if (!factory || !copilot(reviewer)) continue;
      const previous = byReviewer.get(reviewer);
      if (previous && ['CHANGES_REQUESTED','DISMISSED'].includes(previous.state)) continue;
      if (previous?.state === 'APPROVED' && (entry.head !== head || entry.summaryDisposition === 'clear')) continue;
      if (entry.head !== head) {
        byReviewer.delete(reviewer);
        continue;
      }
      // Only an explicitly normalized favorable summary qualifies; missing or
      // contradictory summary evidence cannot become approval.
      const summaryDisposition = ['clear','actionable','uncertain'].includes(entry.summaryDisposition) ? entry.summaryDisposition : 'uncertain';
      byReviewer.set(reviewer,{reviewer,head:entry.head,state:'COMMENTED',summaryDisposition});
      continue;
    }
    // A stale approval cannot supersede an outstanding objection or qualify.
    if (entry.state === 'APPROVED' && entry.head !== head) {
      if (['APPROVED','COMMENTED'].includes(byReviewer.get(reviewer)?.state)) byReviewer.delete(reviewer);
      continue;
    }
    byReviewer.set(reviewer,{reviewer,head:entry.head,state:entry.state});
  }
  return {ok:true,reviews:[...byReviewer.values()],reason:'NORMALIZED_ONLY'};
}
