// Pure normalization only. A trusted adapter must establish completeness,
// chronological order, and reviewer identity before calling this function.
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const dense = a => Array.isArray(a) && Object.keys(a).length === a.length &&
  Array.from({length:a.length}, (_,i) => Object.hasOwn(a,i)).every(Boolean);
const invalid = () => ({ok:false, reviews:[], reason:'AMBIGUOUS_REVIEW_HISTORY'});
export function normalizeReviewHistory(head, history) {
  if (!sha(head) || !dense(history)) return invalid();
  const byReviewer = new Map();
  let lastSequence = 0;
  for (const entry of history) {
    if (!entry || typeof entry !== 'object' ||
        !Number.isSafeInteger(entry.sequence) || entry.sequence <= lastSequence ||
        typeof entry.reviewer !== 'string' || !/^[a-z0-9][a-z0-9-]*$/i.test(entry.reviewer) ||
        !sha(entry.head) ||
        !['APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'].includes(entry.state)) return invalid();
    lastSequence = entry.sequence;
    const reviewer = entry.reviewer.toLowerCase();
    // A comment is not a decision and cannot overwrite an earlier objection.
    if (entry.state === 'COMMENTED') continue;
    // A stale approval cannot supersede an outstanding objection or qualify.
    if (entry.state === 'APPROVED' && entry.head !== head) continue;
    byReviewer.set(reviewer,{reviewer,head:entry.head,state:entry.state});
  }
  return {ok:true,reviews:[...byReviewer.values()],reason:'NORMALIZED_ONLY'};
}
