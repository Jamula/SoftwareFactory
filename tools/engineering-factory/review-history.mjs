import {types} from 'node:util';
import {planReviewBatch} from './review-batch.mjs';

// Pure normalization only. A trusted adapter must establish completeness,
// chronological order, and reviewer identity before calling this function.
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const text = s => typeof s === 'string' && s.length > 0 && s.length <= 100;
const data = (v, keys) => v !== null && typeof v === 'object' && !types.isProxy(v) && !Array.isArray(v) &&
  keys.every(k => Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, 'value'));
const dense = a => !types.isProxy(a) && Array.isArray(a) && Object.getPrototypeOf(a) === Array.prototype &&
  Object.keys(a).length === a.length &&
  Array.from({length:a.length}, (_,i) => Object.hasOwn(Object.getOwnPropertyDescriptor(a, i) ?? {}, 'value')).every(Boolean);
const invalid = () => ({ok:false, reviews:[], reason:'AMBIGUOUS_REVIEW_HISTORY'});
const copilot = r => ['copilot-pull-request-reviewer','copilot-pull-request-reviewer[bot]'].includes(r.toLowerCase());
export function normalizeReviewHistory(head, history, repository) {
  const factory = typeof repository === 'string' && repository.toLowerCase() === 'jamula/softwarefactory';
  if (!sha(head) || !dense(history)) return invalid();
  const byReviewer = new Map();
  let lastSequence = 0;
  for (const entry of history) {
    if (!data(entry, ['sequence', 'reviewer', 'head', 'state']) ||
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
      const hasDisposition = Object.hasOwn(Object.getOwnPropertyDescriptor(entry, 'summaryDisposition') ?? {}, 'value');
      const rawDisposition = hasDisposition ? entry.summaryDisposition : undefined;
      if (previous?.state === 'APPROVED' && (entry.head !== head || rawDisposition === 'clear')) continue;
      if (entry.head !== head) {
        if (previous?.state !== 'COMMENTED' || previous.summaryDisposition === 'clear') byReviewer.delete(reviewer);
        continue;
      }
      // Only an explicitly normalized favorable summary qualifies; missing or
      // contradictory summary evidence cannot become approval.
      const summaryDisposition = ['clear','actionable','uncertain'].includes(rawDisposition) ? rawDisposition : 'uncertain';
      byReviewer.set(reviewer,{reviewer,head:entry.head,state:'COMMENTED',summaryDisposition});
      continue;
    }
    // A stale approval cannot supersede an outstanding objection or qualify.
    if (entry.state === 'APPROVED' && entry.head !== head) {
      const previous = byReviewer.get(reviewer);
      if (previous?.state === 'APPROVED' || (previous?.state === 'COMMENTED' && previous.summaryDisposition === 'clear')) byReviewer.delete(reviewer);
      continue;
    }
    byReviewer.set(reviewer,{reviewer,head:entry.head,state:entry.state});
  }
  return {ok:true,reviews:[...byReviewer.values()],reason:'NORMALIZED_ONLY'};
}

const unverifiedCandidateReview = (reason = 'REVIEW_UNVERIFIED') =>
  ({ok: false, reason, reviewHistory: [], normalizedReviews: [], platformReview: null, batch: null, independentFavorable: false});

export function buildCandidateReviewEvidence(head, history, options) {
  if (!sha(head) || !dense(history) || history.length > 250 || !data(options, ['reviewers', 'author', 'agent']) ||
      !text(options.author) || !text(options.agent) || !dense(options.reviewers) ||
      options.reviewers.length === 0 || options.reviewers.length > 64 || !options.reviewers.every(text))
    return unverifiedCandidateReview();
  const hasRepo = Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'repository') ?? {}, 'value');
  const repository = hasRepo ? options.repository : 'Jamula/SoftwareFactory';
  if (!text(repository)) return unverifiedCandidateReview();
  const hasInline = Object.hasOwn(Object.getOwnPropertyDescriptor(options, 'inlineFindings') ?? {}, 'value');
  const inlineFindings = hasInline ? options.inlineFindings : [];
  if (!dense(inlineFindings) || inlineFindings.length > 256 ||
      inlineFindings.some(f => !data(f, ['id', 'state', 'source']) || f.source !== 'inline'))
    return unverifiedCandidateReview();

  const cleanHistory = [];
  const latestSummaryByReviewer = new Map();
  for (const entry of history) {
    if (!data(entry, ['sequence', 'reviewer', 'head', 'state'])) return unverifiedCandidateReview();
    if (entry.state === 'PENDING') return unverifiedCandidateReview('REVIEW_PENDING');
    const hasDisposition = Object.hasOwn(Object.getOwnPropertyDescriptor(entry, 'summaryDisposition') ?? {}, 'value');
    const item = {sequence: entry.sequence, reviewer: entry.reviewer, head: entry.head, state: entry.state};
    if (hasDisposition && typeof entry.summaryDisposition === 'string') item.summaryDisposition = entry.summaryDisposition;
    cleanHistory.push(item);
    const hasSummaryFindings = Object.hasOwn(Object.getOwnPropertyDescriptor(entry, 'summaryFindings') ?? {}, 'value');
    if (entry.head === head && entry.state === 'COMMENTED' && typeof entry.reviewer === 'string' && copilot(entry.reviewer)) {
      const summaryFindings = hasSummaryFindings ? entry.summaryFindings : [];
      if (!dense(summaryFindings) || summaryFindings.length > 64 ||
          summaryFindings.some(f => !data(f, ['id', 'state', 'source']) || f.source !== 'summary'))
        return unverifiedCandidateReview();
      latestSummaryByReviewer.set(entry.reviewer.toLowerCase(),
        summaryFindings.map(f => ({id: f.id, state: f.state, source: f.source})));
    }
  }

  const normalized = normalizeReviewHistory(head, cleanHistory, repository);
  if (!normalized.ok) return unverifiedCandidateReview();

  const findings = inlineFindings.map(f => ({id: f.id, state: f.state, source: f.source}));
  for (const review of normalized.reviews) {
    if (review.head === head && review.state === 'COMMENTED') {
      findings.push(...(latestSummaryByReviewer.get(review.reviewer) ?? []));
    }
  }
  if (findings.length > 256) return unverifiedCandidateReview();

  const isFactory = repository.toLowerCase() === 'jamula/softwarefactory';
  const allowlisted = new Set(options.reviewers.map(r => r.toLowerCase()));
  const excluded = new Set([options.author.toLowerCase(), options.agent.toLowerCase()]);
  const hasObjection = normalized.reviews.some(r => r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED');
  const nonClearComment = normalized.reviews.some(r => r.state === 'COMMENTED' && r.summaryDisposition !== 'clear');
  const independentCleared = !hasObjection && !nonClearComment && normalized.reviews.some(r =>
    r.head === head && allowlisted.has(r.reviewer) && !excluded.has(r.reviewer) &&
    (r.state === 'APPROVED' || (isFactory && copilot(r.reviewer) && r.state === 'COMMENTED' && r.summaryDisposition === 'clear')));
  const commentReview = normalized.reviews.find(r => r.head === head && r.state === 'COMMENTED');
  let summaryDisposition = 'uncertain';
  if (findings.some(f => f.state === 'actionable') || commentReview?.summaryDisposition === 'actionable') {
    summaryDisposition = 'actionable';
  } else if (commentReview) {
    summaryDisposition = commentReview.summaryDisposition;
  } else if (independentCleared) {
    summaryDisposition = 'clear';
  }

  const independentPresent = !hasObjection && (independentCleared ||
    (commentReview !== undefined && allowlisted.has(commentReview.reviewer) && !excluded.has(commentReview.reviewer)));
  const platformReview = {head, complete: true, independent: independentPresent, summaryDisposition, findings};
  const batch = planReviewBatch(head, platformReview);
  if (batch.reason === 'FINDINGS_UNKNOWN' || batch.reason === 'CONFLICTING_FINDINGS') return unverifiedCandidateReview();
  return {
    ok: true,
    reason: 'NORMALIZED_ONLY',
    reviewHistory: cleanHistory,
    normalizedReviews: normalized.reviews,
    platformReview,
    batch,
    independentFavorable: independentCleared && batch.state === 'no-repair'
  };
}
