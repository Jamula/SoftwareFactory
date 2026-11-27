import {types} from 'node:util';
import {planReviewBatch} from './review-batch.mjs';

// Pure normalization only. A trusted adapter must establish completeness,
// chronological order, and reviewer identity before calling this function.
const sha = s => typeof s === 'string' && /^[a-f0-9]{40}$/.test(s);
const text = (s, max = 100) => typeof s === 'string' && s.length > 0 && s.length <= max;
const validRepo = s => text(s, 140) && /^[A-Za-z0-9_.-]{1,39}\/[A-Za-z0-9_.-]{1,100}$/.test(s) &&
  !s.split('/').some(part => part === '.' || part === '..');
const data = (v, keys) => v !== null && typeof v === 'object' && !types.isProxy(v) && !Array.isArray(v) &&
  keys.every(k => Object.hasOwn(Object.getOwnPropertyDescriptor(v, k) ?? {}, 'value'));
const dense = a => !types.isProxy(a) && Array.isArray(a) && Object.getPrototypeOf(a) === Array.prototype &&
  Reflect.ownKeys(a).length === a.length + 1 &&
  Object.hasOwn(Object.getOwnPropertyDescriptor(a, 'length') ?? {}, 'value') &&
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

function optionalOwnData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined) return {present: false, valid: !(key in target), value: undefined};
  if (!Object.hasOwn(descriptor, 'value')) return {present: true, valid: false, value: undefined};
  return {present: true, valid: true, value: descriptor.value};
}

export function buildCandidateReviewEvidence(head, history, options) {
  if (!sha(head) || !dense(history) || history.length > 250 || !data(options, ['reviewers', 'author', 'agent']) ||
      Object.getPrototypeOf(options) !== Object.prototype ||
      !text(options.author) || !text(options.agent) || !dense(options.reviewers) ||
      options.reviewers.length === 0 || options.reviewers.length > 64 || !options.reviewers.every(r => text(r)))
    return unverifiedCandidateReview();
  const repoProp = optionalOwnData(options, 'repository');
  if (!repoProp.valid) return unverifiedCandidateReview();
  const repository = repoProp.present ? repoProp.value : 'Jamula/SoftwareFactory';
  if (!validRepo(repository)) return unverifiedCandidateReview();
  const inlineProp = optionalOwnData(options, 'inlineFindings');
  if (!inlineProp.valid) return unverifiedCandidateReview();
  const inlineFindings = inlineProp.present ? inlineProp.value : [];
  if (!dense(inlineFindings) || inlineFindings.length > 256 ||
      inlineFindings.some(f => !data(f, ['id', 'state', 'source']) || f.source !== 'inline'))
    return unverifiedCandidateReview();

  const isFactory = repository.toLowerCase() === 'jamula/softwarefactory';
  const botLogin = s => typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*\[bot\]$/i.test(s);
  const approvalInput = [];
  const latestCopilotSummary = new Map();
  let lastObservedSequence = 0;
  for (const entry of history) {
    if (!data(entry, ['sequence', 'reviewer', 'head', 'state']) ||
        Object.getPrototypeOf(entry) !== Object.prototype ||
        !Number.isSafeInteger(entry.sequence) || entry.sequence <= lastObservedSequence ||
        !sha(entry.head)) return unverifiedCandidateReview();
    if (entry.state === 'PENDING') return unverifiedCandidateReview('REVIEW_PENDING');
    lastObservedSequence = entry.sequence;
    const dispProp = optionalOwnData(entry, 'summaryDisposition');
    const summaryProp = optionalOwnData(entry, 'summaryFindings');
    if (!dispProp.valid || !summaryProp.valid) return unverifiedCandidateReview();
    const item = {sequence: entry.sequence, reviewer: entry.reviewer, head: entry.head, state: entry.state};
    if (dispProp.present && dispProp.value !== undefined) {
      if (!['clear', 'actionable', 'uncertain'].includes(dispProp.value)) return unverifiedCandidateReview();
      item.summaryDisposition = dispProp.value;
    }
    const isCopilotEntry = typeof entry.reviewer === 'string' && copilot(entry.reviewer);
    if (isCopilotEntry) {
      const reviewerKey = entry.reviewer.toLowerCase();
      if (entry.state === 'COMMENTED') {
        if (entry.head === head) {
          const summaryFindings = summaryProp.present ? summaryProp.value : [];
          if (!dense(summaryFindings) || summaryFindings.length > 64 ||
              summaryFindings.some(f => !data(f, ['id', 'state', 'source']) || f.source !== 'summary'))
            return unverifiedCandidateReview();
          const disposition = ['clear', 'actionable', 'uncertain'].includes(item.summaryDisposition)
            ? item.summaryDisposition : 'uncertain';
          latestCopilotSummary.set(reviewerKey, {
            disposition,
            findings: summaryFindings.map(f => ({id: f.id, state: f.state, source: f.source}))
          });
        } else if (latestCopilotSummary.get(reviewerKey)?.disposition === 'clear') {
          latestCopilotSummary.delete(reviewerKey);
        }
      } else if (entry.head === head && ['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(entry.state)) {
        latestCopilotSummary.delete(reviewerKey);
      }
    }
    // Informational [bot] COMMENTED entries (non-Copilot bots, or Copilot on non-factory repos)
    // cannot satisfy approval gates, while Copilot summary findings and inline findings still apply.
    if (entry.state === 'COMMENTED' && botLogin(entry.reviewer) && (!isFactory || !isCopilotEntry)) {
      continue;
    }
    approvalInput.push(item);
  }

  const normalized = normalizeReviewHistory(head, approvalInput, repository);
  if (!normalized.ok) return unverifiedCandidateReview();

  const findings = inlineFindings.map(f => ({id: f.id, state: f.state, source: f.source}));
  let observedSummaryDisposition = null;
  for (const summary of latestCopilotSummary.values()) {
    findings.push(...summary.findings);
    if (summary.disposition === 'actionable') observedSummaryDisposition = 'actionable';
    else if (summary.disposition === 'uncertain' && observedSummaryDisposition !== 'actionable') {
      observedSummaryDisposition = 'uncertain';
    } else if (observedSummaryDisposition === null) {
      observedSummaryDisposition = summary.disposition;
    }
  }
  if (findings.length > 256) return unverifiedCandidateReview();

  const allowlisted = new Set(options.reviewers.map(r => r.toLowerCase()));
  const excluded = new Set([options.author.toLowerCase(), options.agent.toLowerCase()]);
  const hasObjection = normalized.reviews.some(r => r.state === 'CHANGES_REQUESTED' || r.state === 'DISMISSED');
  const nonClearComment = normalized.reviews.some(r => r.state === 'COMMENTED' && r.summaryDisposition !== 'clear') ||
    (observedSummaryDisposition !== null && observedSummaryDisposition !== 'clear');
  const independentCleared = !hasObjection && !nonClearComment && normalized.reviews.some(r =>
    r.head === head && allowlisted.has(r.reviewer) && !excluded.has(r.reviewer) &&
    (r.state === 'APPROVED' || (isFactory && copilot(r.reviewer) && r.state === 'COMMENTED' && r.summaryDisposition === 'clear')));
  const commentReview = normalized.reviews.find(r => r.head === head && r.state === 'COMMENTED');
  let summaryDisposition = 'uncertain';
  if (findings.some(f => f.state === 'actionable') ||
      commentReview?.summaryDisposition === 'actionable' ||
      observedSummaryDisposition === 'actionable') {
    summaryDisposition = 'actionable';
  } else if (observedSummaryDisposition === 'uncertain' || commentReview?.summaryDisposition === 'uncertain') {
    summaryDisposition = 'uncertain';
  } else if (commentReview) {
    summaryDisposition = commentReview.summaryDisposition;
  } else if (independentCleared) {
    summaryDisposition = 'clear';
  }

  const independentPresent = !hasObjection && (independentCleared ||
    normalized.reviews.some(r => r.head === head && r.state === 'APPROVED' &&
      allowlisted.has(r.reviewer) && !excluded.has(r.reviewer)) ||
    (commentReview !== undefined && allowlisted.has(commentReview.reviewer) && !excluded.has(commentReview.reviewer)));
  const platformReview = {head, complete: true, independent: independentPresent, summaryDisposition, findings};
  const batch = planReviewBatch(head, platformReview);
  if (batch.reason === 'FINDINGS_UNKNOWN' || batch.reason === 'CONFLICTING_FINDINGS') return unverifiedCandidateReview();
  return {
    ok: true,
    reason: 'NORMALIZED_ONLY',
    reviewHistory: approvalInput,
    normalizedReviews: normalized.reviews,
    platformReview,
    batch,
    independentFavorable: independentCleared && batch.state === 'no-repair'
  };
}
