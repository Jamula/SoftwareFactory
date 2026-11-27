// Pure, deterministic, read-only evaluator for Issue #8's owner-directed PR merge
// latency SLO and non-additive stage-delay attribution. Never infers publication
// from updated_at, never resets lifecycle clocks on head changes, re-drafting, or
// retries, never sums parallel overlapping stages as wall time, and grants zero
// merge, scheduling, or gate-bypass authority.
import {types} from 'node:util';
import {prLifecycle} from './pr-lifecycle.mjs';

export const DEFAULT_FACTORY_REPOSITORY_ID = 1471342715;
export const MAX_STAGE_DURATION_MS = 7 * 86_400_000;

export const ALLOWED_SAMPLE_PROVENANCES = Object.freeze([
  'github-timeline',
  'synthetic-fixture'
]);

export const ALLOWED_PUBLICATION_SOURCES = Object.freeze([
  'timeline',
  'creation-state'
]);

export const ALLOWED_PR_STATES = Object.freeze([
  'open',
  'merged',
  'closed-unmerged'
]);

export const ALLOWED_HUMAN_EXCEPTION_CATEGORIES = Object.freeze([
  'authorization',
  'permission',
  'budget',
  'conflicting-intent',
  'safety-blocker'
]);

export const STAGE_ATTRIBUTION_KEYS = Object.freeze([
  'ciQueueWaitMs',
  'linuxRuntimeMs',
  'windowsRuntimeMs',
  'securityScanMs',
  'reviewReworkMs',
  'publicationIdleMs',
  'eligibilityToEnqueueMs',
  'mergeQueueRevalidationMs',
  'mainVerificationMs'
]);

export const PARALLEL_STAGE_KEYS = Object.freeze([
  'ciQueueWaitMs',
  'linuxRuntimeMs',
  'windowsRuntimeMs',
  'securityScanMs',
  'reviewReworkMs'
]);

export const PR_MERGE_LATENCY_SLO_TARGETS = Object.freeze({
  draftToPublishMs: Object.freeze({
    targetMs: 180_000,
    stretchMs: 60_000,
    primaryQuantile: 'p50',
    openAgeKey: 'openDraftAgeMs'
  }),
  publishToMergeMs: Object.freeze({
    targetMs: 420_000,
    stretchMs: 180_000,
    primaryQuantile: 'p50',
    openAgeKey: 'openPublishedAgeMs'
  }),
  creationToMergeMs: Object.freeze({
    targetMs: 600_000,
    stretchMs: 240_000,
    primaryQuantile: 'p50',
    openAgeKey: 'openAgeMs'
  }),
  eligibleToMergeMs: Object.freeze({
    targetMs: 120_000,
    stretchMs: 30_000,
    primaryQuantile: 'p95',
    openAgeKey: 'openEligibleAgeMs'
  }),
  mergeToVerifiedMainMs: Object.freeze({
    targetMs: 120_000,
    stretchMs: 60_000,
    primaryQuantile: 'p50',
    openAgeKey: 'verificationPendingAgeMs'
  })
});

const METRIC_KEYS = Object.freeze(Object.keys(PR_MERGE_LATENCY_SLO_TARGETS));
const provenanceSet = new Set(ALLOWED_SAMPLE_PROVENANCES);
const publicationSourceSet = new Set(ALLOWED_PUBLICATION_SOURCES);
const prStateSet = new Set(ALLOWED_PR_STATES);
const exceptionCategorySet = new Set(ALLOWED_HUMAN_EXCEPTION_CATEGORIES);
const parallelStageSet = new Set(PARALLEL_STAGE_KEYS);
const humanTouchKinds = new Set(['routine', 'exception']);

const SAMPLE_REQUIRED_KEYS = Object.freeze([
  'prNumber',
  'repositoryId',
  'provenance',
  'historyComplete',
  'creationStateVerified',
  'publicationSource',
  'createdAsDraft',
  'createdAt',
  'observedAt',
  'publicationEvents',
  'headCommits',
  'eligibilityTimestamps',
  'retryTimestamps',
  'mergedAt',
  'mainVerifiedAt',
  'humanTouchesComplete',
  'humanTouches',
  'stages'
]);
const SAMPLE_OPTIONAL_KEYS = Object.freeze(['enqueuedAt', 'state', 'closedAt']);

const OPTION_OPTIONAL_KEYS = Object.freeze([
  'repositoryId',
  'provenance',
  'cohort',
  'fromMs',
  'toMs',
  'observedAt',
  'nowMs',
  'maxAgeMs',
  'sourceComplete'
]);

const ROUTINE_TOUCH_KEYS = Object.freeze(['kind', 'at', 'summary']);
const EXCEPTION_TOUCH_KEYS = Object.freeze([
  'kind',
  'category',
  'at',
  'summary',
  'attemptedRemediation',
  'requiredIntervention'
]);

const isPositiveSafeInt = value => Number.isSafeInteger(value) && value > 0;
const isNonNegSafeInt = value => Number.isSafeInteger(value) && value >= 0;
const isSha40 = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const isCohortSlug = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const isSafeText = value =>
  typeof value === 'string' && value.trim().length >= 3 && value.length <= 240 &&
  !/[\u0000-\u001f\u007f]/.test(value);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !types.isProxy(value) &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOwnEnumerableData(target, key) {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && descriptor.enumerable === true &&
    Object.hasOwn(descriptor, 'value') && descriptor.value !== undefined;
}

function hasAllPlainStringDataKeys(value) {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !hasOwnEnumerableData(value, key)) return false;
  }
  return true;
}

function isExactDataObject(value, requiredKeys, optionalKeys = []) {
  if (!isPlainObject(value) || !hasAllPlainStringDataKeys(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return false;
  }
  return requiredKeys.every(key => Object.hasOwn(value, key));
}

function isDenseDataArray(value, maxLength) {
  if (types.isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return false;
  }
  const length = value.length;
  if (length > maxLength || Reflect.ownKeys(value).length !== length + 1) return false;
  for (let i = 0; i < length; i++) {
    if (!hasOwnEnumerableData(value, i)) return false;
  }
  return true;
}

function nearestRankPercentiles(values) {
  if (values.length === 0) return {p50Ms: null, p95Ms: null};
  const sorted = [...values].sort((a, b) => a - b);
  const pick = p => sorted[Math.ceil(p * sorted.length) - 1];
  return {p50Ms: pick(0.5), p95Ms: pick(0.95)};
}

function invalidSample(reason) {
  return Object.freeze({
    valid: false,
    known: false,
    shadow: true,
    readOnly: true,
    liveMerge: false,
    reason
  });
}

function invalidCohort(reason) {
  return Object.freeze({
    valid: false,
    known: false,
    shadow: true,
    readOnly: true,
    liveMerge: false,
    sloMet: null,
    stretchMet: null,
    reason
  });
}

function parsePublicationEvents(events, createdAsDraft, createdAt, ceilingAt, mergedAt) {
  if (!isDenseDataArray(events, 128)) return {ok: false, reason: 'PUBLICATION_EVIDENCE_UNKNOWN'};
  let expectedNext = createdAsDraft ? 'published' : 'redrafted';
  let prevAt = createdAt;
  let firstPublishedAt = createdAsDraft ? null : createdAt;
  let redraftCount = 0;
  let republishCount = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!isExactDataObject(ev, ['type', 'at']) || ev.type !== expectedNext || !isNonNegSafeInt(ev.at)) {
      return {ok: false, reason: 'PUBLICATION_EVIDENCE_UNKNOWN'};
    }
    const minAtValid = i === 0 && createdAsDraft ? ev.at > createdAt : ev.at >= prevAt;
    if (!minAtValid || ev.at > ceilingAt) {
      return {ok: false, reason: 'INVALID_TIMELINE_ORDER'};
    }
    if (ev.type === 'published') {
      if (firstPublishedAt === null) firstPublishedAt = ev.at;
      else republishCount++;
      expectedNext = 'redrafted';
    } else {
      redraftCount++;
      expectedNext = 'published';
    }
    prevAt = ev.at;
  }
  const currentlyDraft = expectedNext === 'published';
  if (mergedAt !== null && currentlyDraft) {
    return {ok: false, reason: 'MERGED_WHILE_DRAFT'};
  }
  return {ok: true, firstPublishedAt, redraftCount, republishCount, currentlyDraft};
}

function parseHeadCommits(commits, createdAt, ceilingAt) {
  if (!isDenseDataArray(commits, 128) || commits.length === 0) {
    return {ok: false, reason: 'HEAD_HISTORY_UNKNOWN'};
  }
  let prevAt = createdAt;
  let prevSha = null;
  const distinct = new Set();
  for (let i = 0; i < commits.length; i++) {
    const item = commits[i];
    if (!isExactDataObject(item, ['sha', 'at']) || !isSha40(item.sha) || !isNonNegSafeInt(item.at)) {
      return {ok: false, reason: 'HEAD_HISTORY_UNKNOWN'};
    }
    if ((i === 0 ? item.at !== createdAt : item.at < prevAt) || item.at > ceilingAt || item.sha === prevSha) {
      return {ok: false, reason: 'INVALID_HEAD_TIMELINE'};
    }
    distinct.add(item.sha);
    prevAt = item.at;
    prevSha = item.sha;
  }
  return {
    ok: true,
    initialHead: commits[0].sha,
    finalHead: prevSha,
    headChangesCount: commits.length - 1,
    distinctHeadCount: distinct.size
  };
}

function parseMonotonicTimestamps(list, floorAt, ceilingAt, maxLen, shapeReason) {
  if (!isDenseDataArray(list, maxLen)) return {ok: false, reason: shapeReason};
  let prev = floorAt;
  for (let i = 0; i < list.length; i++) {
    const at = list[i];
    if (!isNonNegSafeInt(at) || at < prev || at > ceilingAt) {
      return {ok: false, reason: 'INVALID_TIMELINE_ORDER'};
    }
    prev = at;
  }
  return {ok: true};
}

function parseHumanTouches(touches, touchesComplete, prNumber, createdAt, observedAt) {
  if (typeof touchesComplete !== 'boolean') {
    return {ok: false, reason: 'HUMAN_TOUCH_EVIDENCE_UNKNOWN'};
  }
  if (touches === null) {
    if (touchesComplete) return {ok: false, reason: 'HUMAN_TOUCH_EVIDENCE_UNKNOWN'};
    return {
      ok: true,
      complete: false,
      humanTouchesCount: null,
      routineHumanTouchesCount: null,
      exceptionHumanTouchesCount: null,
      observedRoutineCount: 0,
      observedExceptionCount: 0,
      zeroRoutineHumanTouchesMet: null,
      exceptions: Object.freeze([])
    };
  }
  if (!isDenseDataArray(touches, 64)) return {ok: false, reason: 'HUMAN_TOUCH_EVIDENCE_UNKNOWN'};
  let routineCount = 0;
  let exceptionCount = 0;
  const exceptions = [];
  for (let i = 0; i < touches.length; i++) {
    const item = touches[i];
    if (!isPlainObject(item) || !hasOwnEnumerableData(item, 'kind') || !humanTouchKinds.has(item.kind)) {
      return {ok: false, reason: 'HUMAN_TOUCH_EVIDENCE_UNKNOWN'};
    }
    if (item.kind === 'routine') {
      if (!isExactDataObject(item, ROUTINE_TOUCH_KEYS) ||
          !isNonNegSafeInt(item.at) || item.at < createdAt || item.at > observedAt ||
          !isSafeText(item.summary)) {
        return {ok: false, reason: 'HUMAN_TOUCH_EVIDENCE_UNKNOWN'};
      }
      routineCount++;
    } else {
      if (!isExactDataObject(item, EXCEPTION_TOUCH_KEYS) ||
          !exceptionCategorySet.has(item.category) ||
          !isNonNegSafeInt(item.at) || item.at < createdAt || item.at > observedAt ||
          !isSafeText(item.summary) || !isSafeText(item.attemptedRemediation) ||
          !isSafeText(item.requiredIntervention)) {
        return {ok: false, reason: 'HUMAN_TOUCH_EVIDENCE_UNKNOWN'};
      }
      exceptionCount++;
      exceptions.push(Object.freeze({
        prNumber,
        category: item.category,
        at: item.at,
        summary: item.summary,
        attemptedRemediation: item.attemptedRemediation,
        requiredIntervention: item.requiredIntervention
      }));
    }
  }
  return {
    ok: true,
    complete: touchesComplete,
    humanTouchesCount: touchesComplete ? touches.length : null,
    routineHumanTouchesCount: touchesComplete ? routineCount : null,
    exceptionHumanTouchesCount: touchesComplete ? exceptionCount : null,
    observedRoutineCount: routineCount,
    observedExceptionCount: exceptionCount,
    zeroRoutineHumanTouchesMet: routineCount > 0 ? false : (touchesComplete ? true : null),
    exceptions: Object.freeze(exceptions)
  };
}

function parseStageAttribution(stages, context) {
  if (!isExactDataObject(stages, STAGE_ATTRIBUTION_KEYS)) {
    return {ok: false, reason: 'STAGE_ATTRIBUTION_UNKNOWN'};
  }
  const normalized = {};
  for (const key of STAGE_ATTRIBUTION_KEYS) {
    const val = stages[key];
    if (val !== null && (!isNonNegSafeInt(val) || val > MAX_STAGE_DURATION_MS)) {
      return {ok: false, reason: 'STAGE_ATTRIBUTION_UNKNOWN'};
    }
    normalized[key] = val;
  }
  const {firstPublishedAt, firstEligibleAt, enqueuedAt, mergedAt, mainVerifiedAt} = context;
  if ((firstEligibleAt === null && normalized.eligibilityToEnqueueMs !== null) ||
      (firstPublishedAt === null && normalized.mergeQueueRevalidationMs !== null) ||
      (mainVerifiedAt === null && normalized.mainVerificationMs !== null) ||
      (mainVerifiedAt !== null && normalized.mainVerificationMs !== null &&
       normalized.mainVerificationMs !== mainVerifiedAt - mergedAt) ||
      (enqueuedAt !== null && normalized.eligibilityToEnqueueMs !== null &&
       normalized.eligibilityToEnqueueMs !== enqueuedAt - firstEligibleAt) ||
      (mergedAt !== null && firstEligibleAt !== null && normalized.eligibilityToEnqueueMs !== null &&
       normalized.eligibilityToEnqueueMs > mergedAt - firstEligibleAt)) {
    return {ok: false, reason: 'INCONSISTENT_STAGE_ATTRIBUTION'};
  }
  const parallelObserved = PARALLEL_STAGE_KEYS
    .map(key => normalized[key])
    .filter(val => val !== null);
  const parallelEnvelopeMaxMs = parallelObserved.length > 0 ? Math.max(...parallelObserved) : null;
  return {
    ok: true,
    stageAttribution: Object.freeze({
      additiveWallClock: false,
      parallelStagesOverlap: true,
      summedWallClockMs: null,
      parallelEnvelopeMaxMs,
      stages: Object.freeze(normalized)
    })
  };
}

/**
 * Evaluate a single PR lifecycle and stage-attribution sample without resetting
 * clocks on head changes, re-drafting, re-eligibility, or retries.
 */
export function evaluatePullMergeLatencySample(sample) {
  if (!isPlainObject(sample) || !hasAllPlainStringDataKeys(sample)) {
    return invalidSample('INVALID_SAMPLE');
  }
  if (Object.hasOwn(sample, 'updated_at') || Object.hasOwn(sample, 'updatedAt') ||
      sample.publicationSource === 'updated_at' || sample.provenance === 'updated_at') {
    return invalidSample('UPDATED_AT_FORBIDDEN');
  }
  if (!isExactDataObject(sample, SAMPLE_REQUIRED_KEYS, SAMPLE_OPTIONAL_KEYS) ||
      !isPositiveSafeInt(sample.prNumber) || sample.prNumber > 1_000_000_000 ||
      !isPositiveSafeInt(sample.repositoryId)) {
    return invalidSample('INVALID_SAMPLE');
  }
  if (!provenanceSet.has(sample.provenance)) {
    return invalidSample('UNTRUSTED_PROVENANCE');
  }
  if (sample.creationStateVerified !== true || typeof sample.createdAsDraft !== 'boolean') {
    return invalidSample('CREATION_STATE_UNVERIFIED');
  }
  if (!publicationSourceSet.has(sample.publicationSource) ||
      (sample.createdAsDraft && sample.publicationSource !== 'timeline')) {
    return invalidSample('PUBLICATION_EVIDENCE_UNKNOWN');
  }
  if (typeof sample.historyComplete !== 'boolean' || !sample.historyComplete ||
      !isNonNegSafeInt(sample.createdAt) || !isNonNegSafeInt(sample.observedAt) ||
      sample.observedAt < sample.createdAt) {
    return invalidSample('HISTORY_UNKNOWN');
  }
  if (sample.mergedAt !== null && !isNonNegSafeInt(sample.mergedAt)) {
    return invalidSample('MERGE_UNKNOWN');
  }
  if (sample.mainVerifiedAt !== null &&
      (!isNonNegSafeInt(sample.mainVerifiedAt) || sample.mergedAt === null)) {
    return invalidSample('VERIFICATION_UNKNOWN');
  }

  const hasState = Object.hasOwn(sample, 'state');
  const rawClosedAt = Object.hasOwn(sample, 'closedAt') ? sample.closedAt : null;
  if (rawClosedAt !== null && !isNonNegSafeInt(rawClosedAt)) {
    return invalidSample('CLOSURE_EVIDENCE_UNKNOWN');
  }
  const state = hasState ? sample.state : (sample.mergedAt !== null ? 'merged' : 'open');
  if (!prStateSet.has(state)) {
    return invalidSample('CLOSURE_EVIDENCE_UNKNOWN');
  }
  if (state === 'merged') {
    if (sample.mergedAt === null || sample.mergedAt > sample.observedAt ||
        (rawClosedAt !== null && rawClosedAt !== sample.mergedAt)) {
      return invalidSample('MERGE_UNKNOWN');
    }
  } else if (state === 'open') {
    if (sample.mergedAt !== null || rawClosedAt !== null) {
      return invalidSample('CLOSURE_EVIDENCE_UNKNOWN');
    }
  } else if (sample.mergedAt !== null || rawClosedAt === null ||
      rawClosedAt < sample.createdAt || rawClosedAt > sample.observedAt) {
    return invalidSample('CLOSURE_EVIDENCE_UNKNOWN');
  }

  const closedUnmerged = state === 'closed-unmerged';
  const closedAt = state === 'merged' ? sample.mergedAt : rawClosedAt;
  const ceilingAt = closedAt ?? sample.observedAt;

  const pub = parsePublicationEvents(
    sample.publicationEvents,
    sample.createdAsDraft,
    sample.createdAt,
    ceilingAt,
    sample.mergedAt
  );
  if (!pub.ok) return invalidSample(pub.reason);

  const lifecycle = prLifecycle({
    created: sample.createdAt,
    initialDraft: sample.createdAsDraft,
    firstPublished: pub.firstPublishedAt,
    historyComplete: sample.historyComplete,
    merged: sample.mergedAt,
    mainVerified: sample.mainVerifiedAt,
    observed: sample.observedAt
  });
  if (!lifecycle.known) return invalidSample(lifecycle.reason);

  const heads = parseHeadCommits(sample.headCommits, sample.createdAt, ceilingAt);
  if (!heads.ok) return invalidSample(heads.reason);

  let firstEligibleAt = null;
  let reeligibilityCount = 0;
  if (!isDenseDataArray(sample.eligibilityTimestamps, 64)) {
    return invalidSample('ELIGIBILITY_EVIDENCE_UNKNOWN');
  }
  if (sample.eligibilityTimestamps.length > 0) {
    if (pub.firstPublishedAt === null) {
      return invalidSample('ELIGIBILITY_BEFORE_PUBLICATION');
    }
    const eligCheck = parseMonotonicTimestamps(
      sample.eligibilityTimestamps,
      pub.firstPublishedAt,
      ceilingAt,
      64,
      'ELIGIBILITY_EVIDENCE_UNKNOWN'
    );
    if (!eligCheck.ok) return invalidSample(eligCheck.reason);
    firstEligibleAt = sample.eligibilityTimestamps[0];
    reeligibilityCount = sample.eligibilityTimestamps.length - 1;
  }

  const enqueuedAt = Object.hasOwn(sample, 'enqueuedAt') ? sample.enqueuedAt : null;
  if (enqueuedAt !== null &&
      (firstEligibleAt === null || !isNonNegSafeInt(enqueuedAt) ||
       enqueuedAt < firstEligibleAt || enqueuedAt > ceilingAt)) {
    return invalidSample('INVALID_ENQUEUE_TIMESTAMP');
  }

  const retryCheck = parseMonotonicTimestamps(
    sample.retryTimestamps,
    sample.createdAt,
    ceilingAt,
    64,
    'RETRY_EVIDENCE_UNKNOWN'
  );
  if (!retryCheck.ok) return invalidSample(retryCheck.reason);

  const touches = parseHumanTouches(
    sample.humanTouches,
    sample.humanTouchesComplete,
    sample.prNumber,
    sample.createdAt,
    sample.observedAt
  );
  if (!touches.ok) return invalidSample(touches.reason);

  const stageResult = parseStageAttribution(sample.stages, {
    firstPublishedAt: pub.firstPublishedAt,
    firstEligibleAt,
    enqueuedAt,
    mergedAt: sample.mergedAt,
    mainVerifiedAt: sample.mainVerifiedAt
  });
  if (!stageResult.ok) return invalidSample(stageResult.reason);

  const eligibleToMergeMs = firstEligibleAt !== null && sample.mergedAt !== null
    ? sample.mergedAt - firstEligibleAt
    : null;
  const censored = state === 'open';
  const openEligibleAgeMs = firstEligibleAt !== null && censored
    ? sample.observedAt - firstEligibleAt
    : null;
  const unattendedMerge = sample.mergedAt === null
    ? false
    : (touches.observedRoutineCount > 0 ? false : (touches.complete ? true : null));

  return Object.freeze({
    valid: true,
    known: true,
    shadow: true,
    readOnly: true,
    liveMerge: false,
    reason: 'SAMPLE_MEASURED',
    prNumber: sample.prNumber,
    repositoryId: sample.repositoryId,
    provenance: sample.provenance,
    state,
    closedAt,
    closedUnmerged,
    timeToCloseUnmergedMs: closedUnmerged ? closedAt - sample.createdAt : null,
    createdAsDraft: sample.createdAsDraft,
    currentlyDraft: pub.currentlyDraft,
    censored,
    mainVerificationCensored: sample.mergedAt !== null && sample.mainVerifiedAt === null,
    unattendedMerge,
    initialHead: heads.initialHead,
    finalHead: heads.finalHead,
    draftToPublishMs: lifecycle.draftToPublishMs,
    publishToMergeMs: lifecycle.publishToMergeMs,
    creationToMergeMs: lifecycle.createdToMergeMs,
    eligibleToMergeMs,
    mergeToVerifiedMainMs: lifecycle.mergeToVerifiedMs,
    openAgeMs: censored ? lifecycle.openAgeMs : null,
    openDraftAgeMs: censored ? lifecycle.openDraftAgeMs : null,
    openPublishedAgeMs: censored ? lifecycle.openPublishedAgeMs : null,
    openEligibleAgeMs,
    verificationPendingAgeMs: lifecycle.verificationPendingAgeMs,
    headChangesCount: heads.headChangesCount,
    distinctHeadCount: heads.distinctHeadCount,
    redraftCount: pub.redraftCount,
    republishCount: pub.republishCount,
    reeligibilityCount,
    retryCount: sample.retryTimestamps.length,
    humanTouchesComplete: touches.complete,
    humanTouchesCount: touches.humanTouchesCount,
    routineHumanTouchesCount: touches.routineHumanTouchesCount,
    exceptionHumanTouchesCount: touches.exceptionHumanTouchesCount,
    observedRoutineHumanTouchesCount: touches.observedRoutineCount,
    observedExceptionHumanTouchesCount: touches.observedExceptionCount,
    zeroRoutineHumanTouchesMet: touches.zeroRoutineHumanTouchesMet,
    humanTouchExceptions: touches.exceptions,
    stageAttribution: stageResult.stageAttribution
  });
}

function resolveOptions(options) {
  if (options === undefined) {
    return {
      ok: true,
      repositoryId: null,
      provenance: null,
      cohort: null,
      fromMs: null,
      toMs: null,
      observedAt: null,
      sourceComplete: false,
      cohortComplete: false
    };
  }
  if (!isExactDataObject(options, [], OPTION_OPTIONAL_KEYS)) {
    return {ok: false, reason: 'INVALID_OPTIONS'};
  }
  if (Object.hasOwn(options, 'repositoryId') && !isPositiveSafeInt(options.repositoryId)) {
    return {ok: false, reason: 'INVALID_OPTIONS'};
  }
  if (Object.hasOwn(options, 'provenance') && !provenanceSet.has(options.provenance)) {
    return {ok: false, reason: 'UNTRUSTED_PROVENANCE'};
  }
  const hasCohort = Object.hasOwn(options, 'cohort');
  if (hasCohort && !isCohortSlug(options.cohort)) {
    return {ok: false, reason: 'INVALID_OPTIONS'};
  }
  const hasFrom = Object.hasOwn(options, 'fromMs');
  const hasTo = Object.hasOwn(options, 'toMs');
  const hasSourceComplete = Object.hasOwn(options, 'sourceComplete');
  const hasObserved = Object.hasOwn(options, 'observedAt');
  const hasNow = Object.hasOwn(options, 'nowMs');
  const hasMaxAge = Object.hasOwn(options, 'maxAgeMs');
  const hasAnyWindowField = hasFrom || hasTo || hasSourceComplete;
  if (hasAnyWindowField) {
    if (!hasFrom || !hasTo || !hasSourceComplete || !hasCohort ||
        !hasObserved || !hasNow || !hasMaxAge ||
        !isNonNegSafeInt(options.fromMs) || !isNonNegSafeInt(options.toMs) ||
        options.fromMs >= options.toMs || typeof options.sourceComplete !== 'boolean') {
      return {ok: false, reason: 'COHORT_WINDOW_UNKNOWN'};
    }
  }
  if (hasObserved || hasNow || hasMaxAge) {
    if (!hasObserved || !hasNow || !hasMaxAge ||
        !isNonNegSafeInt(options.observedAt) || !isNonNegSafeInt(options.nowMs) ||
        !isPositiveSafeInt(options.maxAgeMs) || options.observedAt > options.nowMs ||
        (hasTo && options.observedAt < options.toMs)) {
      return {ok: false, reason: 'FRESHNESS_UNKNOWN'};
    }
    if (options.nowMs - options.observedAt > options.maxAgeMs) {
      return {ok: false, reason: 'STALE_EVIDENCE'};
    }
  }
  return {
    ok: true,
    repositoryId: options.repositoryId ?? null,
    provenance: options.provenance ?? null,
    cohort: options.cohort ?? null,
    fromMs: hasFrom ? options.fromMs : null,
    toMs: hasTo ? options.toMs : null,
    observedAt: hasObserved ? options.observedAt : null,
    sourceComplete: hasSourceComplete ? options.sourceComplete : false,
    cohortComplete: hasAnyWindowField && options.sourceComplete === true
  };
}

function summarizeLifecycleMetric(metricKey, evaluatedSamples, cohortComplete) {
  const spec = PR_MERGE_LATENCY_SLO_TARGETS[metricKey];
  const durations = [];
  let censoredCount = 0;
  let closedUnmergedCount = 0;
  let unknownCount = 0;
  let unreachedCount = 0;
  let targetMissCount = 0;
  let stretchMissCount = 0;
  let overdueOpenCount = 0;
  let stretchOverdueOpenCount = 0;

  for (const row of evaluatedSamples) {
    const duration = row[metricKey];
    const openAge = row[spec.openAgeKey];
    if (duration !== null) {
      durations.push(duration);
      if (duration > spec.targetMs) targetMissCount++;
      if (duration > spec.stretchMs) stretchMissCount++;
    } else if (row.closedUnmerged) {
      closedUnmergedCount++;
    } else if (openAge !== null) {
      censoredCount++;
      if (openAge > spec.targetMs) overdueOpenCount++;
      if (openAge > spec.stretchMs) stretchOverdueOpenCount++;
    } else if (!row.censored) {
      unknownCount++;
    } else {
      unreachedCount++;
    }
  }

  const sampleCount = durations.length;
  const {p50Ms, p95Ms} = nearestRankPercentiles(durations);
  const evaluable = cohortComplete && unknownCount === 0 && p50Ms !== null;
  const p50MeetsTarget = evaluable ? p50Ms <= spec.targetMs : null;
  const p95MeetsTarget = evaluable ? p95Ms <= spec.targetMs : null;
  const p50MeetsStretch = evaluable ? p50Ms <= spec.stretchMs : null;
  const p95MeetsStretch = evaluable ? p95Ms <= spec.stretchMs : null;
  const meetsTarget = spec.primaryQuantile === 'p95' ? p95MeetsTarget : p50MeetsTarget;
  const meetsStretch = spec.primaryQuantile === 'p95' ? p95MeetsStretch : p50MeetsStretch;

  return Object.freeze({
    metric: metricKey,
    targetMs: spec.targetMs,
    stretchMs: spec.stretchMs,
    primaryQuantile: spec.primaryQuantile,
    sampleCount,
    censoredCount,
    closedUnmergedCount,
    unknownCount,
    unreachedCount,
    p50Ms,
    p95Ms,
    targetMissCount,
    stretchMissCount,
    missRate: sampleCount === 0 ? null : targetMissCount / sampleCount,
    stretchMissRate: sampleCount === 0 ? null : stretchMissCount / sampleCount,
    overdueOpenCount,
    stretchOverdueOpenCount,
    p50MeetsTarget,
    p95MeetsTarget,
    p50MeetsStretch,
    p95MeetsStretch,
    meetsTarget,
    meetsStretch
  });
}

function summarizeStageAttribution(evaluatedSamples) {
  const stages = {};
  for (const stageKey of STAGE_ATTRIBUTION_KEYS) {
    const values = [];
    let unknownCount = 0;
    for (const row of evaluatedSamples) {
      const value = row.stageAttribution.stages[stageKey];
      if (value === null) unknownCount++;
      else values.push(value);
    }
    const {p50Ms, p95Ms} = nearestRankPercentiles(values);
    const maxMs = values.length === 0 ? null : Math.max(...values);
    stages[stageKey] = Object.freeze({
      stage: stageKey,
      parallel: parallelStageSet.has(stageKey),
      sampleCount: values.length,
      unknownCount,
      p50Ms,
      p95Ms,
      maxMs
    });
  }
  return Object.freeze({
    additiveWallClock: false,
    parallelStagesOverlap: true,
    summedWallClockMs: null,
    parallelStageKeys: PARALLEL_STAGE_KEYS,
    stages: Object.freeze(stages)
  });
}

/**
 * Evaluate Issue #8's PR merge latency SLO and non-additive stage-delay attribution
 * across one repository and provenance cohort.
 */
export function evaluatePullMergeLatencySlo(samples, options) {
  const opts = resolveOptions(options);
  if (!opts.ok) return invalidCohort(opts.reason);
  if (!isDenseDataArray(samples, 10_000)) return invalidCohort('INVALID_SAMPLES');
  if (samples.length === 0) return invalidCohort('NO_SAMPLES');

  let cohortRepoId = opts.repositoryId;
  let cohortProvenance = opts.provenance;
  const seenPrs = new Set();
  const evaluated = [];

  let createdReadyCount = 0;
  let createdDraftCount = 0;
  let mergedCount = 0;
  let openCensoredCount = 0;
  let closedUnmergedCount = 0;
  let mainVerifiedCount = 0;
  let verificationPendingCount = 0;
  let unattendedMergedCount = 0;
  let unknownUnattendedMergedCount = 0;
  let maxSampleObservedAt = 0;

  let headChangesCount = 0;
  let redraftCount = 0;
  let republishCount = 0;
  let reeligibilityCount = 0;
  let retryCount = 0;
  let prsWithHeadChangesCount = 0;
  let prsWithRedraftCount = 0;

  let observedRoutineTouchesSum = 0;
  let observedExceptionTouchesSum = 0;
  let unknownHumanTouchesCount = 0;
  const allExceptions = [];
  const openPullRequests = [];
  const closedUnmergedPullRequests = [];

  for (let i = 0; i < samples.length; i++) {
    const raw = samples[i];
    const measured = evaluatePullMergeLatencySample(raw);
    if (!measured.valid) return invalidCohort(measured.reason);

    if (cohortRepoId === null) cohortRepoId = measured.repositoryId;
    else if (measured.repositoryId !== cohortRepoId) return invalidCohort('REPOSITORY_SCOPE_MISMATCH');

    if (cohortProvenance === null) cohortProvenance = measured.provenance;
    else if (measured.provenance !== cohortProvenance) {
      return invalidCohort('PROVENANCE_ISOLATION_VIOLATION');
    }

    if (seenPrs.has(measured.prNumber)) return invalidCohort('DUPLICATE_PR_SAMPLE');
    seenPrs.add(measured.prNumber);

    if (opts.fromMs !== null && (raw.createdAt < opts.fromMs || raw.createdAt >= opts.toMs)) {
      return invalidCohort('SAMPLE_OUTSIDE_WINDOW');
    }
    if (opts.observedAt !== null) {
      if (raw.observedAt > opts.observedAt) return invalidCohort('SAMPLE_AFTER_OBSERVATION');
      if (measured.mergeToVerifiedMainMs === null && raw.observedAt < opts.observedAt) {
        return invalidCohort('STALE_EVIDENCE');
      }
    }
    if (raw.observedAt > maxSampleObservedAt) maxSampleObservedAt = raw.observedAt;

    evaluated.push(measured);

    if (measured.createdAsDraft) createdDraftCount++;
    else createdReadyCount++;

    if (measured.closedUnmerged) {
      closedUnmergedCount++;
      closedUnmergedPullRequests.push(Object.freeze({
        prNumber: measured.prNumber,
        createdAsDraft: measured.createdAsDraft,
        currentlyDraft: measured.currentlyDraft,
        closedAt: measured.closedAt,
        timeToCloseUnmergedMs: measured.timeToCloseUnmergedMs
      }));
    } else if (measured.censored) {
      openCensoredCount++;
    } else {
      mergedCount++;
    }

    if (measured.mergeToVerifiedMainMs !== null) mainVerifiedCount++;
    else if (measured.mainVerificationCensored) verificationPendingCount++;

    if (measured.unattendedMerge === true) unattendedMergedCount++;
    else if (measured.unattendedMerge === null) unknownUnattendedMergedCount++;

    headChangesCount += measured.headChangesCount;
    redraftCount += measured.redraftCount;
    republishCount += measured.republishCount;
    reeligibilityCount += measured.reeligibilityCount;
    retryCount += measured.retryCount;
    if (measured.headChangesCount > 0) prsWithHeadChangesCount++;
    if (measured.redraftCount > 0) prsWithRedraftCount++;

    observedRoutineTouchesSum += measured.observedRoutineHumanTouchesCount;
    observedExceptionTouchesSum += measured.observedExceptionHumanTouchesCount;
    if (!measured.humanTouchesComplete) unknownHumanTouchesCount++;
    for (const ex of measured.humanTouchExceptions) allExceptions.push(ex);

    if (measured.censored || measured.mainVerificationCensored) {
      openPullRequests.push(Object.freeze({
        prNumber: measured.prNumber,
        currentlyDraft: measured.currentlyDraft,
        openAgeMs: measured.openAgeMs,
        openDraftAgeMs: measured.openDraftAgeMs,
        openPublishedAgeMs: measured.openPublishedAgeMs,
        openEligibleAgeMs: measured.openEligibleAgeMs,
        verificationPendingAgeMs: measured.verificationPendingAgeMs
      }));
    }
  }

  if (opts.observedAt === null &&
      evaluated.some((m, idx) =>
        m.mergeToVerifiedMainMs === null && samples[idx].observedAt < maxSampleObservedAt)) {
    return invalidCohort('STALE_EVIDENCE');
  }

  const allTouchesComplete = unknownHumanTouchesCount === 0;
  const humanTouchesCount = allTouchesComplete
    ? observedRoutineTouchesSum + observedExceptionTouchesSum
    : null;
  const routineHumanTouchesCount = allTouchesComplete ? observedRoutineTouchesSum : null;
  const exceptionHumanTouchesCount = allTouchesComplete ? observedExceptionTouchesSum : null;
  const zeroRoutineHumanTouchesMet = observedRoutineTouchesSum > 0
    ? false
    : (allTouchesComplete ? true : null);

  const metrics = {};
  let anyTargetMissed = observedRoutineTouchesSum > 0;
  let anyTargetUnmeasured = !allTouchesComplete;
  let anyStretchMissed = observedRoutineTouchesSum > 0;
  let anyStretchUnmeasured = !allTouchesComplete;

  for (const key of METRIC_KEYS) {
    const summary = summarizeLifecycleMetric(key, evaluated, opts.cohortComplete);
    metrics[key] = summary;
    if (summary.meetsTarget === false || summary.overdueOpenCount > 0) anyTargetMissed = true;
    else if (summary.meetsTarget === null) anyTargetUnmeasured = true;

    if (summary.meetsStretch === false || summary.stretchOverdueOpenCount > 0) anyStretchMissed = true;
    else if (summary.meetsStretch === null) anyStretchUnmeasured = true;
  }

  const known = opts.cohortComplete;
  const status = known ? 'complete' : 'partial';
  const sloMet = known ? (anyTargetMissed ? false : (anyTargetUnmeasured ? null : true)) : null;
  const stretchMet = known ? (anyStretchMissed ? false : (anyStretchUnmeasured ? null : true)) : null;
  const reason = !known
    ? 'PARTIAL_COHORT_EVIDENCE'
    : (sloMet === true ? 'SLO_MET' : (sloMet === false ? 'SLO_MISSED' : 'SLO_INCOMPLETE'));

  return Object.freeze({
    valid: true,
    known,
    status,
    shadow: true,
    readOnly: true,
    liveMerge: false,
    reason,
    repositoryId: cohortRepoId,
    provenance: cohortProvenance,
    cohort: opts.cohort,
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    observedMs: opts.observedAt,
    sourceComplete: opts.sourceComplete,
    humanTouchesComplete: allTouchesComplete,
    sampleCount: evaluated.length,
    sloMet,
    stretchMet,
    headChangesCount,
    redraftCount,
    humanTouchesCount,
    routineHumanTouchesCount,
    exceptionHumanTouchesCount,
    zeroRoutineHumanTouchesMet,
    counts: Object.freeze({
      total: evaluated.length,
      createdReadyCount,
      createdDraftCount,
      mergedCount,
      openCensoredCount,
      closedUnmergedCount,
      mainVerifiedCount,
      verificationPendingCount,
      unattendedMergedCount,
      unknownUnattendedMergedCount,
      unknownHumanTouchesCount
    }),
    rework: Object.freeze({
      headChangesCount,
      redraftCount,
      republishCount,
      reeligibilityCount,
      retryCount,
      prsWithHeadChangesCount,
      prsWithRedraftCount,
      clockResetsApplied: 0
    }),
    humanTouches: Object.freeze({
      complete: allTouchesComplete,
      unknownSampleCount: unknownHumanTouchesCount,
      humanTouchesCount,
      routineHumanTouchesCount,
      exceptionHumanTouchesCount,
      observedRoutineCount: observedRoutineTouchesSum,
      observedExceptionCount: observedExceptionTouchesSum,
      zeroRoutineHumanTouchesMet,
      exceptions: Object.freeze(allExceptions)
    }),
    openPullRequests: Object.freeze(openPullRequests),
    closedUnmergedPullRequests: Object.freeze(closedUnmergedPullRequests),
    metrics: Object.freeze(metrics),
    stageAttribution: summarizeStageAttribution(evaluated),
    samples: Object.freeze(evaluated)
  });
}
