import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { startLocalSdk } from "./local-otel-sdk.mjs";
import { telemetrySummary } from "./telemetry.mjs";

export const DEFAULT_REPO = "Jamula/SoftwareFactory";
export const DEFAULT_INTERVAL_SECONDS = 20;
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 300;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BYTES = 1_048_576;
export const MAX_SSE_BUFFER_BYTES = 262_144;
export const CANVAS_ID = "factory-board";
export const CANVAS_DISPLAY_NAME = "SoftwareFactory Live Board";
export const CANVAS_DESCRIPTION =
  "Live auto-refreshing milestone, issue, PR, CI, and merge-queue board for SoftwareFactory.";

const MAX_POST_BYTES = 4096;
const SSE_KEEPALIVE_MS = 15_000;
const noopObserve = (_stage, work) => work();

export const CANONICAL_MILESTONES = Object.freeze([
  Object.freeze({ id: "M01", defaultTitle: "M01 - Autonomous SoftwareFactory" }),
  Object.freeze({ id: "M02", defaultTitle: "M02 - Fast SoftwareFactory" }),
  Object.freeze({ id: "M03", defaultTitle: "M03 - FamilyTree autonomous adoption" }),
  Object.freeze({ id: "M04", defaultTitle: "M04 - Spellbook autonomous adoption" }),
  Object.freeze({ id: "M05", defaultTitle: "M05 - FamilyHub autonomous adoption" }),
]);

const REPO_SLUG_PATTERN = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/;
const MILESTONE_CODE_PATTERN = /\b(M0[1-5])(?:\.(\d{2}(?:\.\d{2})?))?\b/i;
const HISTORICAL_MILESTONE_PATTERN = /^historical\b/i;
const ISSUE_REF_TOKEN_PATTERN =
  /(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\s+|(https?:\/\/[^\s#]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+))?#(\d+)\b/g;

const GRAPHQL_SNAPSHOT_QUERY = [
  "query($owner:String!,$name:String!){",
  "repository(owner:$owner,name:$name){",
  "milestones(first:100,states:[OPEN,CLOSED]){pageInfo{hasNextPage} nodes{number title state}}",
  "openIssues:issues(first:100,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title state url updatedAt labels(first:100){pageInfo{hasNextPage} nodes{name}} milestone{number title}}}",
  "closedIssues:issues(first:100,states:[CLOSED],orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{number title state url updatedAt labels(first:100){pageInfo{hasNextPage} nodes{name}} milestone{number title}}}",
  "openPulls:pullRequests(first:100,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){pageInfo{hasNextPage} nodes{number title isDraft url updatedAt headRefName headRefOid reviewDecision mergeStateStatus autoMergeRequest{enabledAt} mergeQueueEntry{position state} milestone{number title} closingIssuesReferences(first:10){nodes{number repository{nameWithOwner}}} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:100){totalCount pageInfo{hasNextPage} nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}",
  "mergedPulls:pullRequests(first:12,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url mergedAt headRefName milestone{number title} closingIssuesReferences(first:5){nodes{number repository{nameWithOwner}}}}}",
  "}}",
].join(" ");

const GRAPHQL_ISSUES_PAGE_QUERY = [
  "query($owner:String!,$name:String!,$state:IssueState!,$cursor:String!){",
  "repository(owner:$owner,name:$name){",
  "issues(first:100,after:$cursor,states:[$state],orderBy:{field:UPDATED_AT,direction:DESC}){",
  "pageInfo{hasNextPage endCursor}",
  "nodes{number title state url updatedAt labels(first:100){pageInfo{hasNextPage} nodes{name}} milestone{number title}}",
  "}}}",
].join(" ");

export function parseRepoSlug(repo) {
  if (typeof repo !== "string") {
    throw new Error("INVALID_REPO_SLUG");
  }
  const match = REPO_SLUG_PATTERN.exec(repo.trim());
  if (!match) {
    throw new Error("INVALID_REPO_SLUG");
  }
  return { owner: match[1], name: match[2], fullName: `${match[1]}/${match[2]}` };
}

export function validateIntervalSeconds(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_INTERVAL_SECONDS ||
    value > MAX_INTERVAL_SECONDS
  ) {
    return {
      valid: false,
      reason: "INVALID_INTERVAL",
      message: `Auto-refresh intervalSeconds must be an integer between ${MIN_INTERVAL_SECONDS} and ${MAX_INTERVAL_SECONDS}.`,
    };
  }
  return { valid: true, intervalSeconds: value };
}

export function extractMilestoneStep(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { milestoneId: null, stepId: null };
  }
  const match = MILESTONE_CODE_PATTERN.exec(text);
  if (!match) {
    return { milestoneId: null, stepId: null };
  }
  const milestoneId = match[1].toUpperCase();
  const stepId = match[2] ? `${milestoneId}.${match[2]}` : null;
  return { milestoneId, stepId };
}

function isHistoricalMilestoneTitle(title) {
  return typeof title === "string" && HISTORICAL_MILESTONE_PATTERN.test(title.trim());
}

function extractPriority(labels, title) {
  for (const label of labels) {
    if (label === "P0" || label === "P1" || label === "P2") {
      return label;
    }
  }
  const match = typeof title === "string" ? /\b(P[0-2])\b/.exec(title) : null;
  return match ? match[1] : null;
}

export function extractReferencedIssueNumbers(title, closingRefs, repo = DEFAULT_REPO) {
  const targetRepo = typeof repo === "string" ? repo.trim().toLowerCase() : "";
  const seen = new Set();
  if (Array.isArray(closingRefs)) {
    for (const ref of closingRefs) {
      const refRepo = typeof ref?.repo === "string" ? ref.repo.trim().toLowerCase() : "";
      if (
        Number.isSafeInteger(ref?.number) &&
        ref.number > 0 &&
        refRepo.length > 0 &&
        refRepo === targetRepo
      ) {
        seen.add(ref.number);
      }
    }
  }
  if (typeof title === "string") {
    for (const match of title.matchAll(ISSUE_REF_TOKEN_PATTERN)) {
      const qualifier = match[1] ?? match[2];
      if (qualifier !== undefined && qualifier.toLowerCase() !== targetRepo) {
        continue;
      }
      const parsed = Number.parseInt(match[3], 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        seen.add(parsed);
      }
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function inferIssueMilestoneId(issue) {
  const milestoneTitle = issue.milestoneTitle;
  if (milestoneTitle && !isHistoricalMilestoneTitle(milestoneTitle)) {
    const fromMilestone = extractMilestoneStep(milestoneTitle).milestoneId;
    if (fromMilestone) {
      return fromMilestone;
    }
  }
  for (const label of issue.labels) {
    const fromLabel = extractMilestoneStep(label).milestoneId;
    if (fromLabel) {
      return fromLabel;
    }
  }
  return extractMilestoneStep(issue.title).milestoneId;
}

export function inferPullMilestoneId(pull, issueMilestoneMap) {
  const historicalMilestone = Boolean(
    pull.milestoneTitle && isHistoricalMilestoneTitle(pull.milestoneTitle),
  );
  if (pull.milestoneTitle && !historicalMilestone) {
    const fromMilestone = extractMilestoneStep(pull.milestoneTitle).milestoneId;
    if (fromMilestone) {
      return fromMilestone;
    }
  }
  if (!historicalMilestone) {
    const fromTitle = extractMilestoneStep(pull.title).milestoneId;
    if (fromTitle) {
      return fromTitle;
    }
  }
  for (const issueNumber of pull.linkedIssueNumbers) {
    const mapped = issueMilestoneMap.get(issueNumber);
    if (mapped) {
      return mapped;
    }
  }
  return null;
}

function parseAggregateCheckState(raw) {
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  const upper = raw.toUpperCase();
  if (upper === "SUCCESS") {
    return "PASS";
  }
  if (upper === "FAILURE" || upper === "ERROR") {
    return "FAIL";
  }
  if (upper === "PENDING" || upper === "EXPECTED") {
    return "PENDING";
  }
  return null;
}

export function normalizeCheckRollup(rollup) {
  if (!rollup || typeof rollup !== "object") {
    return { state: "UNKNOWN", total: 0, passed: 0, failed: 0, pending: 0, truncated: false };
  }
  const aggregateState = parseAggregateCheckState(rollup.state);
  const contexts = Array.isArray(rollup.contexts) ? rollup.contexts : null;
  const reportedTotal =
    Number.isSafeInteger(rollup.totalCount) && rollup.totalCount >= 0 ? rollup.totalCount : null;
  const truncated =
    rollup.truncated === true ||
    (contexts !== null && reportedTotal !== null && reportedTotal > contexts.length);

  if (!contexts || contexts.length === 0) {
    return {
      state: aggregateState ?? "UNKNOWN",
      total: reportedTotal ?? 0,
      passed: 0,
      failed: 0,
      pending: 0,
      truncated,
    };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  let unrecognized = 0;
  for (const item of contexts) {
    if (!item || typeof item !== "object") {
      unrecognized += 1;
      continue;
    }
    if (typeof item.status === "string") {
      const status = item.status.toUpperCase();
      if (status !== "COMPLETED") {
        pending += 1;
      } else {
        const conclusion = typeof item.conclusion === "string" ? item.conclusion.toUpperCase() : "";
        if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
          passed += 1;
        } else {
          failed += 1;
        }
      }
    } else if (typeof item.state === "string") {
      const state = item.state.toUpperCase();
      if (state === "SUCCESS") {
        passed += 1;
      } else if (state === "PENDING" || state === "EXPECTED") {
        pending += 1;
      } else {
        failed += 1;
      }
    } else {
      unrecognized += 1;
    }
  }

  const counted = passed + failed + pending;
  const total = reportedTotal !== null && reportedTotal > counted ? reportedTotal : counted;
  if (counted === 0) {
    return {
      state: aggregateState ?? "UNKNOWN",
      total,
      passed: 0,
      failed: 0,
      pending: 0,
      truncated,
    };
  }

  const incomplete = truncated || unrecognized > 0 || counted < total;
  let state;
  if (failed > 0 || aggregateState === "FAIL") {
    state = "FAIL";
  } else if (pending > 0 || aggregateState === "PENDING") {
    state = "PENDING";
  } else if (incomplete && aggregateState !== "PASS") {
    state = "UNKNOWN";
  } else {
    state = "PASS";
  }
  return { state, total, passed, failed, pending, truncated };
}

export function normalizeReviewStatus(reviewDecision, reviews) {
  if (typeof reviewDecision === "string" && reviewDecision.length > 0) {
    const upper = reviewDecision.toUpperCase();
    if (
      upper === "APPROVED" ||
      upper === "CHANGES_REQUESTED" ||
      upper === "REVIEW_REQUIRED"
    ) {
      return upper;
    }
  }
  if (reviewDecision === "" || reviewDecision === null) {
    return "PENDING";
  }
  if (!Array.isArray(reviews)) {
    return "UNKNOWN";
  }
  const byAuthor = new Map();
  for (const review of reviews) {
    const login = review?.user?.login;
    const state = typeof review?.state === "string" ? review.state.toUpperCase() : "";
    if (
      typeof login === "string" &&
      login.length > 0 &&
      (state === "APPROVED" || state === "CHANGES_REQUESTED" || state === "DISMISSED")
    ) {
      byAuthor.set(login, state);
    }
  }
  let hasApproved = false;
  for (const state of byAuthor.values()) {
    if (state === "CHANGES_REQUESTED") {
      return "CHANGES_REQUESTED";
    }
    if (state === "APPROVED") {
      hasApproved = true;
    }
  }
  return hasApproved ? "HAS_APPROVAL" : "PENDING";
}

export function normalizeMergeQueue(entry) {
  if (entry === undefined) {
    return { known: false, queued: null, state: "UNKNOWN", position: null };
  }
  if (entry === null) {
    return { known: true, queued: false, state: null, position: null };
  }
  if (typeof entry !== "object") {
    return { known: false, queued: null, state: "UNKNOWN", position: null };
  }
  return {
    known: true,
    queued: true,
    state: typeof entry.state === "string" && entry.state.length > 0 ? entry.state : "QUEUED",
    position: Number.isSafeInteger(entry.position) && entry.position >= 1 ? entry.position : null,
  };
}

export function buildFactoryBoardSnapshot(raw, { repo, source, generatedAt }) {
  const rawMilestones = Array.isArray(raw?.milestones) ? raw.milestones : [];
  const rawIssues = Array.isArray(raw?.issues) ? raw.issues : [];
  const rawOpenPulls = Array.isArray(raw?.openPulls) ? raw.openPulls : [];
  const rawMergedPulls = Array.isArray(raw?.mergedPulls) ? raw.mergedPulls : [];

  const nativeMilestones = new Map();
  for (const m of rawMilestones) {
    if (!m || typeof m.title !== "string" || isHistoricalMilestoneTitle(m.title)) {
      continue;
    }
    const id = extractMilestoneStep(m.title).milestoneId;
    if (!id) {
      continue;
    }
    const state = typeof m.state === "string" && m.state.toUpperCase() === "CLOSED" ? "closed" : "open";
    const existing = nativeMilestones.get(id);
    if (!existing || (existing.state === "closed" && state === "open")) {
      nativeMilestones.set(id, {
        number: Number.isSafeInteger(m.number) ? m.number : null,
        title: m.title,
        state,
      });
    }
  }

  const issueByNumber = new Map();
  const issueMilestoneMap = new Map();
  let anyLabelsTruncated = false;
  for (const item of rawIssues) {
    if (!Number.isSafeInteger(item?.number) || item.number < 1 || typeof item.title !== "string") {
      continue;
    }
    const labelsTruncated = item.labelsTruncated === true;
    if (labelsTruncated) {
      anyLabelsTruncated = true;
    }
    const labels = Array.isArray(item.labels)
      ? item.labels.filter((name) => typeof name === "string")
      : [];
    const state = typeof item.state === "string" && item.state.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN";
    const milestoneTitle = typeof item.milestoneTitle === "string" ? item.milestoneTitle : null;
    const normalized = {
      number: item.number,
      title: item.title,
      state,
      url: typeof item.url === "string" ? item.url : `https://github.com/${repo}/issues/${item.number}`,
      updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
      labels,
      labelsTruncated,
      milestoneTitle,
      stepId: extractMilestoneStep(item.title).stepId,
      priority: extractPriority(labels, item.title),
      milestoneId: null,
      linkedPullNumbers: [],
    };
    normalized.milestoneId = inferIssueMilestoneId(normalized);
    issueByNumber.set(normalized.number, normalized);
    if (normalized.milestoneId) {
      issueMilestoneMap.set(normalized.number, normalized.milestoneId);
    }
  }

  const openPulls = [];
  const seenOpenPullNumbers = new Set();
  for (const pr of rawOpenPulls) {
    if (
      !Number.isSafeInteger(pr?.number) ||
      pr.number < 1 ||
      typeof pr.title !== "string" ||
      seenOpenPullNumbers.has(pr.number)
    ) {
      continue;
    }
    seenOpenPullNumbers.add(pr.number);
    const linkedIssueNumbers = extractReferencedIssueNumbers(
      pr.title,
      pr.closingIssuesReferences,
      repo,
    );
    const milestoneTitle = typeof pr.milestoneTitle === "string" ? pr.milestoneTitle : null;
    const candidate = {
      number: pr.number,
      title: pr.title,
      isDraft: pr.isDraft === true,
      url: typeof pr.url === "string" ? pr.url : `https://github.com/${repo}/pull/${pr.number}`,
      updatedAt: typeof pr.updatedAt === "string" ? pr.updatedAt : null,
      headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
      headSha: typeof pr.headSha === "string" ? pr.headSha : "",
      milestoneTitle,
      linkedIssueNumbers,
      milestoneId: null,
      ci: normalizeCheckRollup(pr.checkRollup),
      reviewStatus: normalizeReviewStatus(pr.reviewDecision, pr.reviews),
      reviewDecisionVerified:
        typeof pr.reviewDecision === "string" || pr.reviewDecision === null,
      mergeStateStatus:
        typeof pr.mergeStateStatus === "string" && pr.mergeStateStatus.length > 0
          ? pr.mergeStateStatus.toUpperCase()
          : "UNKNOWN",
      autoMerge: pr.autoMerge === true,
      mergeQueue: normalizeMergeQueue(pr.mergeQueueEntry),
    };
    candidate.milestoneId = inferPullMilestoneId(candidate, issueMilestoneMap);
    for (const issueNumber of linkedIssueNumbers) {
      const linked = issueByNumber.get(issueNumber);
      if (linked && !linked.linkedPullNumbers.includes(candidate.number)) {
        linked.linkedPullNumbers.push(candidate.number);
      }
    }
    openPulls.push(candidate);
  }

  const mergedPulls = [];
  const seenMergedPullNumbers = new Set();
  for (const pr of rawMergedPulls) {
    if (
      !Number.isSafeInteger(pr?.number) ||
      pr.number < 1 ||
      typeof pr.title !== "string" ||
      seenMergedPullNumbers.has(pr.number)
    ) {
      continue;
    }
    seenMergedPullNumbers.add(pr.number);
    const linkedIssueNumbers = extractReferencedIssueNumbers(
      pr.title,
      pr.closingIssuesReferences,
      repo,
    );
    const milestoneTitle = typeof pr.milestoneTitle === "string" ? pr.milestoneTitle : null;
    const entry = {
      number: pr.number,
      title: pr.title,
      url: typeof pr.url === "string" ? pr.url : `https://github.com/${repo}/pull/${pr.number}`,
      mergedAt: typeof pr.mergedAt === "string" ? pr.mergedAt : null,
      headRefName: typeof pr.headRefName === "string" ? pr.headRefName : "",
      milestoneId: inferPullMilestoneId(
        { title: pr.title, milestoneTitle, linkedIssueNumbers },
        issueMilestoneMap,
      ),
    };
    mergedPulls.push(entry);
  }

  const partial = raw?.truncated === true || anyLabelsTruncated;
  const allIssues = [...issueByNumber.values()].sort((a, b) => a.number - b.number);
  const unassignedIssues = allIssues.filter((issue) => issue.milestoneId === null);

  const milestones = CANONICAL_MILESTONES.map(({ id, defaultTitle }) => {
    const native = nativeMilestones.get(id);
    const issues = allIssues.filter((issue) => issue.milestoneId === id);
    const openCount = issues.filter((issue) => issue.state === "OPEN").length;
    const closedCount = issues.filter((issue) => issue.state === "CLOSED").length;
    const totalIssues = openCount + closedCount;
    const completionPercent = partial
      ? null
      : totalIssues > 0
        ? Math.round((closedCount / totalIssues) * 100)
        : 0;
    const milestonePulls = openPulls.filter((pr) => pr.milestoneId === id);
    const msQueueUnknown = milestonePulls.some((pr) => pr.mergeQueue.known === false);

    return {
      id,
      number: native ? native.number : null,
      title: native ? native.title : defaultTitle,
      state: native ? native.state : "missing",
      openIssues: openCount,
      closedIssues: closedCount,
      totalIssues,
      completionPercent,
      activePulls: milestonePulls.length,
      ciPassingPulls: milestonePulls.filter((pr) => pr.ci.state === "PASS").length,
      ciPendingPulls: milestonePulls.filter((pr) => pr.ci.state === "PENDING").length,
      ciFailingPulls: milestonePulls.filter((pr) => pr.ci.state === "FAIL").length,
      queuedPulls: msQueueUnknown
        ? null
        : milestonePulls.filter((pr) => pr.mergeQueue.queued === true).length,
      issues: issues.map(({ milestoneTitle: _mt, ...rest }) => rest),
    };
  });

  const issuesOpen = allIssues.filter((i) => i.state === "OPEN").length;
  const issuesClosed = allIssues.filter((i) => i.state === "CLOSED").length;
  const issuesTotal = issuesOpen + issuesClosed;
  const queueUnknown = openPulls.some((pr) => pr.mergeQueue.known === false);
  const reviewDecisionUnknown =
    source === "github-rest" || openPulls.some((pr) => pr.reviewStatus === "HAS_APPROVAL");

  return {
    repo,
    source,
    readOnly: true,
    verified: true,
    ok: true,
    partial,
    stale: false,
    error: null,
    generatedAt,
    rateLimit: raw?.rateLimit ?? null,
    totals: {
      milestonesOpen: milestones.filter((m) => m.state === "open").length,
      issuesOpen,
      issuesClosed,
      issuesTotal,
      completionPercent: partial
        ? null
        : issuesTotal > 0
          ? Math.round((issuesClosed / issuesTotal) * 100)
          : 0,
      openPulls: openPulls.length,
      draftPulls: openPulls.filter((pr) => pr.isDraft).length,
      ciPassingPulls: openPulls.filter((pr) => pr.ci.state === "PASS").length,
      ciPendingPulls: openPulls.filter((pr) => pr.ci.state === "PENDING").length,
      ciFailingPulls: openPulls.filter((pr) => pr.ci.state === "FAIL").length,
      ciUnknownPulls: openPulls.filter((pr) => pr.ci.state === "UNKNOWN").length,
      approvedPulls: reviewDecisionUnknown
        ? null
        : openPulls.filter((pr) => pr.reviewStatus === "APPROVED").length,
      queuedPulls: queueUnknown
        ? null
        : openPulls.filter((pr) => pr.mergeQueue.queued === true).length,
      mergedRecentPulls: mergedPulls.length,
    },
    milestones,
    openPulls: openPulls.map(({ milestoneTitle: _mt, reviewDecisionVerified: _rv, ...rest }) => rest),
    mergedPulls,
    unassignedIssues: unassignedIssues.map(({ milestoneTitle: _mt, ...rest }) => rest),
  };
}

export function buildUnavailableSnapshot({ repo, generatedAt, error, previousSnapshot }) {
  const normalizedError = {
    code: typeof error?.code === "string" ? error.code : "SNAPSHOT_UNAVAILABLE",
    message:
      typeof error?.message === "string" && error.message.length > 0
        ? error.message
        : "Unable to read live GitHub metadata.",
  };
  if (
    previousSnapshot &&
    previousSnapshot.repo === repo &&
    previousSnapshot.verified === true
  ) {
    return {
      ...previousSnapshot,
      ok: false,
      stale: true,
      error: normalizedError,
      lastAttemptAt: generatedAt,
    };
  }
  return {
    repo,
    source: "unavailable",
    readOnly: true,
    verified: false,
    ok: false,
    partial: false,
    stale: false,
    error: normalizedError,
    generatedAt,
    totals: null,
    milestones: [],
    openPulls: [],
    mergedPulls: [],
    unassignedIssues: [],
  };
}

export function summarizeSnapshot(snapshot, { intervalSeconds, paused }) {
  return {
    repo: snapshot.repo,
    source: snapshot.source,
    readOnly: true,
    verified: snapshot.verified,
    ok: snapshot.ok,
    partial: snapshot.partial,
    stale: snapshot.stale,
    error: snapshot.error,
    generatedAt: snapshot.generatedAt,
    intervalSeconds,
    paused,
    totals: snapshot.totals,
    milestones: snapshot.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      state: m.state,
      closedIssues: m.closedIssues,
      openIssues: m.openIssues,
      totalIssues: m.totalIssues,
      completionPercent: m.completionPercent,
      activePulls: m.activePulls,
      ciPassingPulls: m.ciPassingPulls,
      ciPendingPulls: m.ciPendingPulls,
      ciFailingPulls: m.ciFailingPulls,
      queuedPulls: m.queuedPulls,
    })),
  };
}

export async function readBoundedJson(response, maxBytes = DEFAULT_MAX_BYTES) {
  if (!response || !response.ok || !response.body) {
    throw new Error("HTTP_UNAVAILABLE");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let raw = "";
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error("RESPONSE_TOO_LARGE");
      }
      raw += decoder.decode(value, { stream: true });
    }
    raw += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(raw);
}

function defaultExecGh(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      "gh",
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          GH_HOST: "github.com",
          GH_PAGER: "",
          GH_PROMPT_DISABLED: "1",
          NO_COLOR: "1",
        },
      },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function assertGraphqlConnection(
  conn,
  { requirePageInfo = true, requireCursorWhenNext = false } = {},
) {
  if (!conn || typeof conn !== "object" || !Array.isArray(conn.nodes)) {
    throw new Error("GH_GRAPHQL_CONNECTION_INVALID");
  }
  if (requirePageInfo) {
    const pageInfo = conn.pageInfo;
    if (!pageInfo || typeof pageInfo !== "object" || typeof pageInfo.hasNextPage !== "boolean") {
      throw new Error("GH_GRAPHQL_CONNECTION_INVALID");
    }
    if (
      requireCursorWhenNext &&
      pageInfo.hasNextPage === true &&
      (typeof pageInfo.endCursor !== "string" || pageInfo.endCursor.length === 0)
    ) {
      throw new Error("GH_GRAPHQL_CONNECTION_INVALID");
    }
  }
}

function addGraphqlIssueNodes(issueMap, bucket) {
  if (!Array.isArray(bucket)) {
    return;
  }
  for (const node of bucket) {
    if (node && Number.isSafeInteger(node.number)) {
      if (node.labels !== null && node.labels !== undefined) {
        assertGraphqlConnection(node.labels);
      }
      issueMap.set(node.number, {
        number: node.number,
        title: node.title,
        state: node.state,
        url: node.url,
        updatedAt: node.updatedAt,
        labels: Array.isArray(node.labels?.nodes)
          ? node.labels.nodes.map((l) => l?.name).filter((n) => typeof n === "string")
          : [],
        labelsTruncated: node.labels?.pageInfo?.hasNextPage === true,
        milestoneTitle: node.milestone?.title ?? null,
      });
    }
  }
}

async function paginateGraphqlIssues({
  owner,
  name,
  state,
  initialPageInfo,
  issueMap,
  execGh,
  timeoutMs,
  maxIssuePages,
}) {
  let hasNextPage = initialPageInfo.hasNextPage === true;
  let cursor = typeof initialPageInfo.endCursor === "string" ? initialPageInfo.endCursor : "";
  let pageCount = 1;
  while (hasNextPage && pageCount < maxIssuePages) {
    const stdout = await execGh(
      [
        "api",
        "--hostname",
        "github.com",
        "graphql",
        "-f",
        `query=${GRAPHQL_ISSUES_PAGE_QUERY}`,
        "-f",
        `owner=${owner}`,
        "-f",
        `name=${name}`,
        "-f",
        `state=${state}`,
        "-f",
        `cursor=${cursor}`,
      ],
      timeoutMs,
    );
    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
      throw new Error("GH_GRAPHQL_ERRORS");
    }
    const conn = parsed?.data?.repository?.issues;
    assertGraphqlConnection(conn, { requireCursorWhenNext: true });
    addGraphqlIssueNodes(issueMap, conn.nodes);
    hasNextPage = conn.pageInfo.hasNextPage === true;
    cursor = typeof conn.pageInfo.endCursor === "string" ? conn.pageInfo.endCursor : "";
    pageCount += 1;
  }
  return hasNextPage;
}

export async function fetchViaGhGraphql({
  owner,
  name,
  execGh = defaultExecGh,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxIssuePages = 5,
}) {
  const stdout = await execGh(
    [
      "api",
      "--hostname",
      "github.com",
      "graphql",
      "-f",
      `query=${GRAPHQL_SNAPSHOT_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    ],
    timeoutMs,
  );
  const parsed = JSON.parse(stdout);
  const repoNode = parsed?.data?.repository;
  if (Array.isArray(parsed?.errors) && parsed.errors.length > 0) {
    throw new Error("GH_GRAPHQL_ERRORS");
  }
  if (!repoNode || typeof repoNode !== "object") {
    throw new Error("GH_REPOSITORY_MISSING");
  }
  assertGraphqlConnection(repoNode.milestones);
  assertGraphqlConnection(repoNode.openIssues, { requireCursorWhenNext: true });
  assertGraphqlConnection(repoNode.closedIssues, { requireCursorWhenNext: true });
  assertGraphqlConnection(repoNode.openPulls);
  assertGraphqlConnection(repoNode.mergedPulls, { requirePageInfo: false });

  const issueMap = new Map();
  addGraphqlIssueNodes(issueMap, repoNode.openIssues.nodes);
  addGraphqlIssueNodes(issueMap, repoNode.closedIssues.nodes);

  const [openTruncated, closedTruncated] = await Promise.all([
    paginateGraphqlIssues({
      owner,
      name,
      state: "OPEN",
      initialPageInfo: repoNode.openIssues.pageInfo,
      issueMap,
      execGh,
      timeoutMs,
      maxIssuePages,
    }),
    paginateGraphqlIssues({
      owner,
      name,
      state: "CLOSED",
      initialPageInfo: repoNode.closedIssues.pageInfo,
      issueMap,
      execGh,
      timeoutMs,
      maxIssuePages,
    }),
  ]);

function mapGraphqlClosingRefs(nodes) {
  if (!Array.isArray(nodes)) {
    return [];
  }
  return nodes.map((r) => ({
    number: r?.number,
    repo: r?.repository?.nameWithOwner ?? null,
  }));
}

  const openPullNodes = Array.isArray(repoNode.openPulls?.nodes) ? repoNode.openPulls.nodes : [];
  const openPulls = openPullNodes.map((node) => {
    const commitRollup = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const checkRollup = commitRollup
      ? {
          state: commitRollup.state,
          totalCount: commitRollup.contexts?.totalCount,
          truncated: commitRollup.contexts?.pageInfo?.hasNextPage === true,
          contexts: Array.isArray(commitRollup.contexts?.nodes) ? commitRollup.contexts.nodes : [],
        }
      : null;
    return {
      number: node?.number,
      title: node?.title,
      isDraft: node?.isDraft === true,
      url: node?.url,
      updatedAt: node?.updatedAt,
      headRefName: node?.headRefName,
      headSha: node?.headRefOid,
      reviewDecision: node?.reviewDecision ?? null,
      mergeStateStatus: node?.mergeStateStatus,
      autoMerge: Boolean(node?.autoMergeRequest),
      mergeQueueEntry:
        node && Object.hasOwn(node, "mergeQueueEntry") ? node.mergeQueueEntry : undefined,
      milestoneTitle: node?.milestone?.title ?? null,
      closingIssuesReferences: mapGraphqlClosingRefs(node?.closingIssuesReferences?.nodes),
      checkRollup,
    };
  });

  const mergedPullNodes = Array.isArray(repoNode.mergedPulls?.nodes)
    ? repoNode.mergedPulls.nodes
    : [];
  const mergedPulls = mergedPullNodes.map((node) => ({
    number: node?.number,
    title: node?.title,
    url: node?.url,
    mergedAt: node?.mergedAt,
    headRefName: node?.headRefName,
    milestoneTitle: node?.milestone?.title ?? null,
    closingIssuesReferences: mapGraphqlClosingRefs(node?.closingIssuesReferences?.nodes),
  }));

  const milestoneNodes = Array.isArray(repoNode.milestones?.nodes) ? repoNode.milestones.nodes : [];
  const milestones = milestoneNodes.map((node) => ({
    number: node?.number,
    title: node?.title,
    state: node?.state,
  }));

  const truncated = Boolean(
    repoNode.milestones?.pageInfo?.hasNextPage ||
      repoNode.openPulls?.pageInfo?.hasNextPage ||
      openTruncated ||
      closedTruncated ||
      [...issueMap.values()].some((i) => i.labelsTruncated),
  );

  return { milestones, issues: [...issueMap.values()], openPulls, mergedPulls, truncated };
}

export function combineRestChecksAndStatus(checksPayload, statusPayload) {
  const checksValid = Array.isArray(checksPayload?.check_runs);
  const statusValid = Array.isArray(statusPayload?.statuses);
  if (!checksValid && !statusValid) {
    return null;
  }
  const checkRuns = checksValid ? checksPayload.check_runs : [];
  const statuses = statusValid ? statusPayload.statuses : [];
  const checksComplete =
    checksValid &&
    Number.isSafeInteger(checksPayload.total_count) &&
    checksPayload.total_count <= checkRuns.length;
  const statusComplete =
    statusValid &&
    Number.isSafeInteger(statusPayload.total_count) &&
    statusPayload.total_count <= statuses.length;
  const legacyAggregate =
    statusValid &&
    Number.isSafeInteger(statusPayload.total_count) &&
    statusPayload.total_count > 0 &&
    typeof statusPayload.state === "string"
      ? statusPayload.state.toUpperCase()
      : null;

  const reportedTotal =
    (checksValid && Number.isSafeInteger(checksPayload.total_count)
      ? Math.max(checksPayload.total_count, checkRuns.length)
      : checkRuns.length) +
    (statusValid && Number.isSafeInteger(statusPayload.total_count)
      ? Math.max(statusPayload.total_count, statuses.length)
      : statuses.length);

  const combinedContexts = [...checkRuns, ...statuses];
  const aggregateHint =
    legacyAggregate === "FAILURE" || legacyAggregate === "ERROR"
      ? "FAILURE"
      : legacyAggregate === "PENDING"
        ? "PENDING"
        : null;

  if (!checksComplete || !statusComplete) {
    const probe = normalizeCheckRollup({
      state: aggregateHint === "FAILURE" ? "FAILURE" : null,
      totalCount: reportedTotal,
      truncated: true,
      contexts: combinedContexts,
    });
    if (probe.state === "FAIL") {
      return {
        state: "FAILURE",
        totalCount: reportedTotal,
        truncated: true,
        contexts: combinedContexts,
      };
    }
    return {
      state: null,
      totalCount: reportedTotal,
      truncated: true,
      contexts: [],
    };
  }

  return {
    state: aggregateHint,
    totalCount: reportedTotal,
    truncated: false,
    contexts: combinedContexts,
  };
}

export function parseRateLimitHeaders(headers, nowMs = Date.now()) {
  const remRaw = headers?.get?.("x-ratelimit-remaining");
  const resetRaw = headers?.get?.("x-ratelimit-reset");
  const retryRaw = headers?.get?.("retry-after");

  const remaining =
    typeof remRaw === "string" && /^\d+$/.test(remRaw.trim())
      ? Number.parseInt(remRaw.trim(), 10)
      : null;
  const resetAtMs =
    typeof resetRaw === "string" && /^\d+$/.test(resetRaw.trim())
      ? Number.parseInt(resetRaw.trim(), 10) * 1000
      : null;
  const retryAfterMs =
    typeof retryRaw === "string" && /^\d+$/.test(retryRaw.trim())
      ? nowMs + Number.parseInt(retryRaw.trim(), 10) * 1000
      : null;

  return { remaining, resetAtMs, retryAfterMs };
}

function hasNextRestPage(response, itemCount, perPage) {
  const linkHeader = response.headers?.get?.("link");
  if (typeof linkHeader === "string" && linkHeader.length > 0) {
    return /\brel="next"/i.test(linkHeader);
  }
  return itemCount >= perPage;
}

export async function fetchViaPublicRest({
  owner,
  name,
  request = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxDetailPulls = 6,
  maxPages = 5,
  maxReviewPages = 3,
  perPage = 100,
  nowMs = Date.now(),
}) {
  const baseUrl = `https://api.github.com/repos/${owner}/${name}`;
  let requestsUsed = 0;
  let minRemaining = null;
  let latestResetAtMs = null;
  let latestRetryAfterMs = null;

  const recordRateLimit = (response) => {
    const rl = parseRateLimitHeaders(response?.headers, nowMs);
    if (rl.remaining !== null && (minRemaining === null || rl.remaining < minRemaining)) {
      minRemaining = rl.remaining;
    }
    if (rl.resetAtMs !== null && (latestResetAtMs === null || rl.resetAtMs > latestResetAtMs)) {
      latestResetAtMs = rl.resetAtMs;
    }
    if (
      rl.retryAfterMs !== null &&
      (latestRetryAfterMs === null || rl.retryAfterMs > latestRetryAfterMs)
    ) {
      latestRetryAfterMs = rl.retryAfterMs;
    }
    if (
      response &&
      (response.status === 429 ||
        (response.status === 403 && (rl.remaining === 0 || rl.retryAfterMs !== null)))
    ) {
      const candidateDeadlines = [rl.retryAfterMs, rl.resetAtMs].filter(
        (v) => typeof v === "number" && Number.isFinite(v),
      );
      const blockedUntilMs =
        candidateDeadlines.length > 0 ? Math.max(...candidateDeadlines) : nowMs + 60_000;
      if (latestRetryAfterMs === null || blockedUntilMs > latestRetryAfterMs) {
        latestRetryAfterMs = blockedUntilMs;
      }
      throw Object.assign(new Error("REST_RATE_LIMITED"), {
        code: "REST_RATE_LIMITED",
        blockedUntilMs,
      });
    }
  };

  const getResponseAndJson = async (path) => {
    requestsUsed += 1;
    const response = await request(`${baseUrl}${path}`, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "user-agent": "SoftwareFactory-Board-Canvas/0.1",
      },
    });
    recordRateLimit(response);
    const json = await readBoundedJson(response, maxBytes);
    return { response, json };
  };

  const getJson = async (path) => (await getResponseAndJson(path)).json;

  const getPaginatedArray = async (pathPrefix, pageLimit = maxPages) => {
    const items = [];
    let truncated = false;
    const sep = pathPrefix.includes("?") ? "&" : "?";
    for (let page = 1; page <= pageLimit; page += 1) {
      const { response, json } = await getResponseAndJson(
        `${pathPrefix}${sep}per_page=${perPage}&page=${page}`,
      );
      if (!Array.isArray(json)) {
        throw new Error("REST_PAYLOAD_INVALID");
      }
      items.push(...json);
      const hasMore = hasNextRestPage(response, json.length, perPage);
      if (!hasMore) {
        break;
      }
      if (page === pageLimit) {
        truncated = true;
      }
    }
    return { items, truncated };
  };

  const getClosedMergedPulls = async (pageLimit = Math.min(maxPages, 3)) => {
    const merged = [];
    const seenMergedNumbers = new Set();
    let truncated = false;
    const closedPerPage = Math.min(perPage, 50);
    for (let page = 1; page <= pageLimit; page += 1) {
      const { response, json } = await getResponseAndJson(
        `/pulls?state=closed&sort=updated&direction=desc&per_page=${closedPerPage}&page=${page}`,
      );
      if (!Array.isArray(json)) {
        throw new Error("REST_PAYLOAD_INVALID");
      }
      for (const pr of json) {
        if (
          pr &&
          Number.isSafeInteger(pr.number) &&
          pr.number > 0 &&
          !seenMergedNumbers.has(pr.number) &&
          typeof pr.merged_at === "string" &&
          pr.merged_at.length > 0
        ) {
          seenMergedNumbers.add(pr.number);
          merged.push(pr);
        }
      }
      const hasMore = hasNextRestPage(response, json.length, closedPerPage);
      if (!hasMore || merged.length >= 12) {
        break;
      }
      if (page === pageLimit) {
        truncated = true;
      }
    }
    return { items: merged.slice(0, 12), truncated };
  };

  const milestonesPaged = await getPaginatedArray("/milestones?state=all");
  const [issuesPaged, openPullsPaged, closedMergedPaged] = await Promise.all([
    getPaginatedArray("/issues?state=all"),
    getPaginatedArray("/pulls?state=open&sort=updated&direction=desc"),
    getClosedMergedPulls(),
  ]);

  const milestones = milestonesPaged.items.map((m) => ({
    number: m?.number,
    title: m?.title,
    state: m?.state,
  }));

  const issues = issuesPaged.items
    .filter((item) => item && !Object.hasOwn(item, "pull_request"))
    .map((item) => ({
      number: item.number,
      title: item.title,
      state: item.state,
      url: item.html_url,
      updatedAt: item.updated_at,
      labels: Array.isArray(item.labels)
        ? item.labels.map((l) => l?.name).filter((n) => typeof n === "string")
        : [],
      labelsTruncated: Array.isArray(item.labels) && item.labels.length >= 100,
      milestoneTitle: item.milestone?.title ?? null,
    }));

  const worstCasePerDetailPull = 2 + Math.max(1, maxReviewPages);
  const detailQuotaCap =
    minRemaining === null
      ? maxDetailPulls
      : Math.max(0, Math.floor((minRemaining - 10) / worstCasePerDetailPull));
  const effectiveMaxDetailPulls = Math.min(maxDetailPulls, detailQuotaCap);

  const seenOpenNumbers = new Set();
  const uniqueOpenPulls = [];
  for (const pr of openPullsPaged.items) {
    if (Number.isSafeInteger(pr?.number) && pr.number > 0) {
      if (seenOpenNumbers.has(pr.number)) {
        continue;
      }
      seenOpenNumbers.add(pr.number);
    }
    uniqueOpenPulls.push(pr);
  }

  const openPulls = await Promise.all(
    uniqueOpenPulls.map(async (pr, index) => {
      const headSha = pr?.head?.sha;
      let checkRollup = null;
      let reviews = undefined;
      if (
        index < effectiveMaxDetailPulls &&
        typeof headSha === "string" &&
        headSha.length > 0 &&
        Number.isSafeInteger(pr?.number)
      ) {
        const [checksResult, statusResult, reviewsResult] = await Promise.allSettled([
          getJson(`/commits/${headSha}/check-runs?per_page=100`),
          getJson(`/commits/${headSha}/status?per_page=100`),
          getPaginatedArray(`/pulls/${pr.number}/reviews`, maxReviewPages),
        ]);
        checkRollup = combineRestChecksAndStatus(
          checksResult.status === "fulfilled" ? checksResult.value : null,
          statusResult.status === "fulfilled" ? statusResult.value : null,
        );
        if (reviewsResult.status === "fulfilled" && !reviewsResult.value.truncated) {
          reviews = reviewsResult.value.items;
        }
      }
      return {
        number: pr?.number,
        title: pr?.title,
        isDraft: pr?.draft === true,
        url: pr?.html_url,
        updatedAt: pr?.updated_at,
        headRefName: pr?.head?.ref,
        headSha,
        reviewDecision: undefined,
        reviews,
        mergeStateStatus: pr?.mergeable_state,
        autoMerge: Boolean(pr?.auto_merge),
        mergeQueueEntry: undefined,
        milestoneTitle: pr?.milestone?.title ?? null,
        closingIssuesReferences: [],
        checkRollup,
      };
    }),
  );

  const mergedPulls = closedMergedPaged.items.map((pr) => ({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    mergedAt: pr.merged_at,
    headRefName: pr.head?.ref,
    milestoneTitle: pr.milestone?.title ?? null,
    closingIssuesReferences: [],
  }));

  const truncated =
    milestonesPaged.truncated ||
    issuesPaged.truncated ||
    openPullsPaged.truncated ||
    closedMergedPaged.truncated;

  let blockedUntilMs = latestRetryAfterMs ?? 0;
  let nextPollAtMs = blockedUntilMs;
  if (minRemaining === 0) {
    blockedUntilMs = Math.max(blockedUntilMs, latestResetAtMs ?? nowMs + 60_000);
    nextPollAtMs = blockedUntilMs;
  } else if (minRemaining !== null && latestResetAtMs !== null && latestResetAtMs > nowMs) {
    const windowMs = latestResetAtMs - nowMs;
    const pollsLeft = Math.max(1, Math.floor(minRemaining / Math.max(1, requestsUsed)));
    nextPollAtMs = Math.max(nextPollAtMs, nowMs + Math.ceil(windowMs / pollsLeft));
  }

  return {
    milestones,
    issues,
    openPulls,
    mergedPulls,
    truncated,
    rateLimit: {
      remaining: minRemaining,
      resetAtMs: latestResetAtMs,
      blockedUntilMs,
      nextPollAtMs,
      requestsUsed,
    },
  };
}

async function runObservedReconcile(observe, work) {
  let result;
  await observe("reconcile", async () => {
    result = await work();
    return telemetrySummary(result.telemetry);
  });
  return result.snapshot;
}

export async function fetchFactoryBoardSnapshot({
  repo = DEFAULT_REPO,
  execGh = defaultExecGh,
  request = fetch,
  clock = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  previousSnapshot = null,
  rateLimitState = null,
  observe = noopObserve,
} = {}) {
  const generatedAt = clock();
  const parsedClockMs = Date.parse(generatedAt);
  const nowMs = Number.isNaN(parsedClockMs) ? Date.now() : parsedClockMs;
  let parsedRepo;
  try {
    parsedRepo = parseRepoSlug(repo);
  } catch {
    return runObservedReconcile(observe, async () => ({
      telemetry: { reason: "INVALID_IDENTITY" },
      snapshot: buildUnavailableSnapshot({
        repo: String(repo),
        generatedAt,
        error: { code: "INVALID_REPO_SLUG", message: "Repository must use owner/name format." },
        previousSnapshot: null,
      }),
    }));
  }

  return runObservedReconcile(observe, async () => {
    try {
      const raw = await fetchViaGhGraphql({
        owner: parsedRepo.owner,
        name: parsedRepo.name,
        execGh,
        timeoutMs,
      });
      if (rateLimitState) {
        rateLimitState.blockedUntilMs = 0;
        rateLimitState.nextPollAtMs = 0;
      }
      return {
        telemetry: { reason: "SHADOW_RECONCILED" },
        snapshot: buildFactoryBoardSnapshot(raw, {
          repo: parsedRepo.fullName,
          source: "gh-graphql",
          generatedAt,
        }),
      };
    } catch {
      if (rateLimitState && rateLimitState.blockedUntilMs > nowMs) {
        return {
          telemetry: { reason: "RATE_LIMIT_OR_UNKNOWN" },
          snapshot: buildUnavailableSnapshot({
            repo: parsedRepo.fullName,
            generatedAt,
            error: {
              code: "REST_RATE_LIMITED",
              message: `Public GitHub REST rate limit active until ${new Date(rateLimitState.blockedUntilMs).toISOString()}.`,
            },
            previousSnapshot,
          }),
        };
      }
      try {
        const raw = await fetchViaPublicRest({
          owner: parsedRepo.owner,
          name: parsedRepo.name,
          request,
          timeoutMs,
          maxBytes,
          nowMs,
        });
        if (rateLimitState && raw.rateLimit) {
          rateLimitState.blockedUntilMs = raw.rateLimit.blockedUntilMs;
          rateLimitState.nextPollAtMs = raw.rateLimit.nextPollAtMs;
        }
        return {
          telemetry: { reason: "SHADOW_RECONCILED" },
          snapshot: buildFactoryBoardSnapshot(raw, {
            repo: parsedRepo.fullName,
            source: "github-rest",
            generatedAt,
          }),
        };
      } catch (restErr) {
        const isRateLimited = restErr?.code === "REST_RATE_LIMITED";
        if (isRateLimited && rateLimitState && Number.isFinite(restErr.blockedUntilMs)) {
          rateLimitState.blockedUntilMs = restErr.blockedUntilMs;
          rateLimitState.nextPollAtMs = restErr.blockedUntilMs;
        }
        return {
          telemetry: { reason: isRateLimited ? "RATE_LIMIT_OR_UNKNOWN" : "READ_FAILED" },
          snapshot: buildUnavailableSnapshot({
            repo: parsedRepo.fullName,
            generatedAt,
            error: {
              code: isRateLimited ? "REST_RATE_LIMITED" : "SNAPSHOT_FETCH_FAILED",
              message:
                restErr instanceof Error && restErr.message
                  ? restErr.message
                  : "Both gh CLI and public GitHub REST reads failed.",
            },
            previousSnapshot,
          }),
        };
      }
    }
  });
}

export function formatBoardStatus(intervalSeconds, paused) {
  return paused ? "Paused" : `Auto-refreshing (${intervalSeconds}s)`;
}

export function createBoardPoller({
  repo = DEFAULT_REPO,
  intervalSeconds: initialInterval = DEFAULT_INTERVAL_SECONDS,
  fetchSnapshot = fetchFactoryBoardSnapshot,
  timers = { setInterval, clearInterval },
  now = Date.now,
  observe = noopObserve,
} = {}) {
  const parsed = parseRepoSlug(repo);
  const validated = validateIntervalSeconds(initialInterval);
  if (!validated.valid) {
    throw new Error(validated.message);
  }

  let currentInterval = validated.intervalSeconds;
  let paused = false;
  let closed = false;
  let snapshot = null;
  let seq = 0;
  let inflight = null;
  let timerHandle = null;
  const rateLimitState = { blockedUntilMs: 0, nextPollAtMs: 0 };
  const listeners = new Set();

  const buildEnvelope = () => ({
    seq,
    snapshot,
    config: {
      repo: parsed.fullName,
      intervalSeconds: currentInterval,
      paused,
      status: formatBoardStatus(currentInterval, paused),
    },
  });

  const notify = () => {
    seq += 1;
    const envelope = buildEnvelope();
    for (const listener of listeners) {
      listener(envelope);
    }
  };

  const stopTimer = () => {
    if (timerHandle !== null) {
      timers.clearInterval(timerHandle);
      timerHandle = null;
    }
  };

  const startTimer = () => {
    stopTimer();
    if (closed || paused) {
      return;
    }
    timerHandle = timers.setInterval(() => {
      if (now() < rateLimitState.nextPollAtMs) {
        return;
      }
      void refresh();
    }, currentInterval * 1000);
    if (timerHandle && typeof timerHandle.unref === "function") {
      timerHandle.unref();
    }
  };

  async function refresh() {
    if (closed) {
      return buildEnvelope();
    }
    if (inflight) {
      return inflight;
    }
    inflight = (async () => {
      try {
        const next = await fetchSnapshot({
          repo: parsed.fullName,
          previousSnapshot: snapshot,
          rateLimitState,
          observe,
        });
        if (next?.rateLimit?.nextPollAtMs > rateLimitState.nextPollAtMs) {
          rateLimitState.nextPollAtMs = next.rateLimit.nextPollAtMs;
        }
        if (!closed) {
          snapshot = next;
          notify();
        }
        return buildEnvelope();
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function setIntervalSeconds(nextSeconds) {
    const check = validateIntervalSeconds(nextSeconds);
    if (!check.valid) {
      return check;
    }
    currentInterval = check.intervalSeconds;
    startTimer();
    notify();
    return { valid: true, ...buildEnvelope().config };
  }

  function setPaused(nextPaused) {
    paused = Boolean(nextPaused);
    if (paused) {
      stopTimer();
    } else {
      startTimer();
    }
    notify();
    return buildEnvelope().config;
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function start() {
    startTimer();
    return refresh();
  }

  function close() {
    closed = true;
    stopTimer();
    listeners.clear();
  }

  return {
    getState: buildEnvelope,
    getSummary: () =>
      snapshot
        ? summarizeSnapshot(snapshot, { intervalSeconds: currentInterval, paused })
        : null,
    start,
    refresh,
    setIntervalSeconds,
    setPaused,
    subscribe,
    close,
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function initFactoryBoardClient(win) {
  const doc = win.document;
  const fetchImpl = win.fetch;
  const EventSourceImpl = win.EventSource;
  const boardToken = doc.body.getAttribute("data-board-token") || "";

  const state = {
    envelope: null,
    lastSeq: -1,
    prFilter: "all",
    openDrawers: new Set(["M01", "M02"]),
    refreshing: false,
    sectionHtml: new Map(),
  };

  function applyEnvelope(next) {
    if (!next || typeof next !== "object") {
      return;
    }
    if (typeof next.seq === "number") {
      if (next.seq < state.lastSeq) {
        return;
      }
      state.lastSeq = next.seq;
    }
    state.envelope = next;
    render();
  }

  const el = (id) => doc.getElementById(id);

  function updateSectionHtml(id, nextHtml, onUpdated) {
    const container = el(id);
    if (state.sectionHtml.get(id) === nextHtml) {
      return;
    }
    const activeKey = doc.activeElement?.getAttribute?.("data-focus-key") ?? null;
    state.sectionHtml.set(id, nextHtml);
    container.innerHTML = nextHtml;
    if (onUpdated) {
      onUpdated(container);
    }
    if (activeKey) {
      const target = [...container.querySelectorAll("[data-focus-key]")].find(
        (n) => n.getAttribute("data-focus-key") === activeKey,
      );
      target?.focus?.({ preventScroll: true });
    }
  }
  const esc = (v) =>
    String(v ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const safeHref = (url) => {
    try {
      const parsed = new URL(String(url));
      return parsed.protocol === "https:" && parsed.hostname === "github.com" ? parsed.href : "#";
    } catch {
      return "#";
    }
  };

  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toISOString().replace("T", " ").slice(0, 19) + " UTC";
  };

  function setSseState(mode, label) {
    const dot = el("sse-dot");
    dot.className = "dot" + (mode === "live" ? " live" : mode === "error" ? " error" : "");
    el("sse-text").textContent = label;
  }

  function ciBadge(ci) {
    if (!ci) return '<span class="pill muted">UNKNOWN</span>';
    const detail = ci.total > 0 ? " " + ci.passed + "/" + ci.total : "";
    if (ci.state === "PASS") return '<span class="pill blue">PASS' + detail + "</span>";
    if (ci.state === "FAIL") return '<span class="pill red">FAIL' + detail + "</span>";
    if (ci.state === "PENDING") return '<span class="pill">PENDING' + detail + "</span>";
    return '<span class="pill muted">UNKNOWN</span>';
  }

  function reviewBadge(status) {
    if (status === "APPROVED") return '<span class="pill blue">APPROVED</span>';
    if (status === "HAS_APPROVAL") return '<span class="pill">APPROVAL OBSERVED</span>';
    if (status === "CHANGES_REQUESTED") return '<span class="pill red">CHANGES REQ</span>';
    if (status === "REVIEW_REQUIRED") return '<span class="pill">REVIEW REQ</span>';
    if (status === "PENDING") return '<span class="pill muted">PENDING</span>';
    return '<span class="pill muted">UNKNOWN</span>';
  }

  function queueBadge(pr) {
    if (pr.mergeQueue && pr.mergeQueue.queued === true) {
      const pos = pr.mergeQueue.position !== null ? " #" + pr.mergeQueue.position : "";
      return '<span class="pill blue">QUEUED' + pos + "</span>";
    }
    const unknownQueue = !pr.mergeQueue || pr.mergeQueue.known === false;
    if (pr.isDraft) {
      return (
        '<span class="pill muted">DRAFT' +
        (unknownQueue ? " · QUEUE UNKNOWN" : "") +
        "</span>"
      );
    }
    const ms = pr.mergeStateStatus || "UNKNOWN";
    const auto = pr.autoMerge ? " · AUTO" : "";
    const suffix = unknownQueue ? " · QUEUE UNKNOWN" : "";
    if (ms === "DIRTY" || ms === "CONFLICTING") {
      return '<span class="pill red">' + esc(ms + auto + suffix) + "</span>";
    }
    if (ms === "CLEAN" && !unknownQueue) {
      return '<span class="pill blue">' + esc(ms + auto) + "</span>";
    }
    return '<span class="pill muted">' + esc(ms + auto + suffix) + "</span>";
  }

  function render() {
    const env = state.envelope;
    if (!env) return;
    const cfg = env.config || {};
    const snap = env.snapshot;

    if (cfg.repo) {
      el("repo-pill").textContent = cfg.repo;
    }
    el("status-text").textContent = cfg.status || "Auto-refreshing";
    const pauseBtn = el("toggle-pause");
    pauseBtn.setAttribute("aria-pressed", cfg.paused ? "true" : "false");
    pauseBtn.textContent = cfg.paused ? "Resume auto-refresh" : "Pause auto-refresh";

    const select = el("interval-select");
    if (cfg.intervalSeconds) {
      const strVal = String(cfg.intervalSeconds);
      if (![...select.options].some((o) => o.value === strVal)) {
        const opt = doc.createElement("option");
        opt.value = strVal;
        opt.textContent = strVal + "s";
        select.appendChild(opt);
      }
      select.value = strVal;
    }

    if (!snap) {
      el("updated-text").textContent = "Loading initial snapshot…";
      return;
    }

    el("source-text").textContent = "Source: " + snap.source;
    el("updated-text").textContent =
      (snap.stale ? "Stale snapshot from " : "Updated ") + fmtTime(snap.generatedAt);

    const banner = el("error-banner");
    const notices = [];
    if (!snap.ok && snap.error) {
      notices.push(
        (snap.stale ? "Degraded (showing last verified snapshot) — " : "Snapshot unavailable — ") +
          snap.error.code +
          ": " +
          snap.error.message,
      );
    }
    if (snap.partial) {
      notices.push(
        "Partial bounded inventory — repository exceeds page cap; sampled counts are not complete progress.",
      );
    }
    if (notices.length > 0) {
      banner.hidden = false;
      banner.textContent = notices.join(" | ");
    } else {
      banner.hidden = true;
      banner.textContent = "";
    }

    const t = snap.totals;
    if (!snap.verified || !t) {
      el("kpi-grid").innerHTML = [
        "Closed Issues (Proxy)",
        "Active Milestones",
        "Open Pull Requests",
        "CI Check Health",
        "Review & Merge Queue",
        "Recent Merges",
      ]
        .map(
          (label) =>
            '<div class="kpi-card">' +
            '<span class="kpi-label">' +
            esc(label) +
            "</span>" +
            '<span class="kpi-value">—</span>' +
            '<span class="kpi-sub">Unavailable until verified read</span>' +
            "</div>",
        )
        .join("");
      const unavailableHtml =
        '<div class="empty-state">Live GitHub metadata unavailable — awaiting verified snapshot.</div>';
      updateSectionHtml("milestones-grid", unavailableHtml);
      updateSectionHtml("open-prs-wrap", unavailableHtml);
      updateSectionHtml("merged-prs-wrap", unavailableHtml);
      return;
    }

    const issueSub = snap.partial
      ? "Sampled subset (pagination cap reached)"
      : t.completionPercent + "% closed (activity proxy, not verified acceptance)";
    el("kpi-grid").innerHTML = [
      {
        label: "Closed Issues (Proxy)",
        value: snap.partial
          ? "≥ " + t.issuesClosed + " closed"
          : t.issuesClosed + " / " + t.issuesTotal,
        sub: issueSub,
      },
      {
        label: "Active Milestones",
        value: t.milestonesOpen + " / " + snap.milestones.length,
        sub: "Roadmap v2 M01–M05",
      },
      {
        label: "Open Pull Requests",
        value: (snap.partial ? "≥ " : "") + String(t.openPulls),
        sub: t.draftPulls + " draft · " + (t.openPulls - t.draftPulls) + " ready",
      },
      {
        label: "CI Check Health",
        value: t.ciPassingPulls + " pass",
        sub: t.ciPendingPulls + " pending · " + t.ciFailingPulls + " failing",
      },
      {
        label: "Review & Merge Queue",
        value: t.queuedPulls === null ? "Unknown queue" : t.queuedPulls + " queued",
        sub:
          t.approvedPulls === null
            ? "Approval gates unverified"
            : t.approvedPulls + " approved open PRs",
      },
      {
        label: "Recent Merges",
        value: String(t.mergedRecentPulls),
        sub: "Recently updated merged PRs",
      },
    ]
      .map(
        (k) =>
          '<div class="kpi-card">' +
          '<span class="kpi-label">' +
          esc(k.label) +
          "</span>" +
          '<span class="kpi-value">' +
          esc(k.value) +
          "</span>" +
          '<span class="kpi-sub">' +
          esc(k.sub) +
          "</span>" +
          "</div>",
      )
      .join("");

    const renderIssueItems = (issues) =>
      issues.length === 0
        ? '<div class="empty-state">No issues assigned</div>'
        : '<ul class="issue-list">' +
          issues
            .map((iss) => {
              const prLinks = (iss.linkedPullNumbers || [])
                .map((num) => '<span class="pill blue mono">PR #' + num + "</span>")
                .join(" ");
              const prio = iss.priority
                ? '<span class="pill' +
                  (iss.priority === "P0" ? " red" : " muted") +
                  '">' +
                  esc(iss.priority) +
                  "</span>"
                : "";
              const step = iss.stepId
                ? '<span class="pill mono muted">' + esc(iss.stepId) + "</span>"
                : "";
              const stBadge =
                iss.state === "CLOSED"
                  ? '<span class="pill blue">CLOSED</span>'
                  : '<span class="pill muted">OPEN</span>';
              const truncPill = iss.labelsTruncated
                ? '<span class="pill muted">LABELS TRUNCATED</span>'
                : "";
              return (
                '<li class="issue-item">' +
                '<div class="issue-main">' +
                stBadge +
                step +
                prio +
                truncPill +
                '<a class="truncate" data-focus-key="issue-' +
                iss.number +
                '" href="' +
                safeHref(iss.url) +
                '" target="_blank" rel="noopener noreferrer" title="' +
                esc(iss.title) +
                '">' +
                '<span class="mono">#' +
                iss.number +
                "</span> " +
                esc(iss.title) +
                "</a>" +
                "</div>" +
                '<div class="chip-row">' +
                prLinks +
                "</div>" +
                "</li>"
              );
            })
            .join("") +
          "</ul>";

    const unassignedList = Array.isArray(snap.unassignedIssues) ? snap.unassignedIssues : [];
    const unassignedCardHtml =
      unassignedList.length === 0
        ? ""
        : (() => {
            const uClosed = unassignedList.filter((i) => i.state === "CLOSED").length;
            const uOpen = unassignedList.filter((i) => i.state === "OPEN").length;
            const uOpenDrawer = state.openDrawers.has("UNASSIGNED");
            const uHasTrunc = unassignedList.some((i) => i.labelsTruncated);
            const uTitle = uHasTrunc ? "Unassigned / Unclassified Issues" : "Unassigned Issues";
            return (
              '<article class="milestone-card">' +
              '<div class="milestone-top">' +
              '<div><div class="milestone-title">' +
              uTitle +
              "</div>" +
              '<div class="meta-row">' +
              esc(uClosed + " closed · " + uOpen + " open") +
              "</div></div>" +
              '<span class="pill muted">Unassigned</span>' +
              "</div>" +
              '<details class="issue-drawer" data-ms="UNASSIGNED"' +
              (uOpenDrawer ? " open" : "") +
              ">" +
              '<summary data-focus-key="ms-summary-UNASSIGNED">Issues (' +
              unassignedList.length +
              ")</summary>" +
              renderIssueItems(unassignedList) +
              "</details>" +
              "</article>"
            );
          })();

    const milestonesHtml =
      snap.milestones
        .map((m) => {
          const isOpen = state.openDrawers.has(m.id);
          const hasKnownPct = m.completionPercent !== null;
          const pctValue = hasKnownPct ? m.completionPercent : 0;
          const pctLabel = hasKnownPct ? m.completionPercent + "%" : "Partial";
          const progressAriaAttrs = hasKnownPct
            ? 'aria-valuenow="' + pctValue + '" aria-valuemin="0" aria-valuemax="100"'
            : 'aria-valuetext="Unknown (partial inventory)"';
          const issuesHtml = renderIssueItems(m.issues);

          return (
            '<article class="milestone-card">' +
            '<div class="milestone-top">' +
            '<div><div class="milestone-title">' +
            esc(m.title) +
            "</div>" +
            '<div class="meta-row">' +
            esc(m.closedIssues + " closed · " + m.openIssues + " open") +
            "</div></div>" +
            '<span class="pill ' +
            (m.completionPercent === 100 && m.totalIssues > 0 ? "blue" : "muted") +
            '">' +
            pctLabel +
            "</span>" +
            "</div>" +
            '<div class="progress-track" role="progressbar" aria-label="' +
            esc(m.title + " closed issue activity proxy") +
            '" ' +
            progressAriaAttrs +
            ">" +
            '<div class="progress-fill" style="width:' +
            pctValue +
            '%"></div>' +
            "</div>" +
            '<div class="chip-row">' +
            '<span class="pill' +
            (m.activePulls > 0 ? " blue" : " muted") +
            '">' +
            m.activePulls +
            " open PR" +
            (m.activePulls === 1 ? "" : "s") +
            "</span>" +
            (m.ciPassingPulls > 0
              ? '<span class="pill blue">' + m.ciPassingPulls + " CI pass</span>"
              : "") +
            (m.ciPendingPulls > 0
              ? '<span class="pill">' + m.ciPendingPulls + " CI pending</span>"
              : "") +
            (m.ciFailingPulls > 0
              ? '<span class="pill red">' + m.ciFailingPulls + " CI fail</span>"
              : "") +
            (m.queuedPulls === null
              ? '<span class="pill muted">Queue unknown</span>'
              : m.queuedPulls > 0
                ? '<span class="pill blue">' + m.queuedPulls + " queued</span>"
                : "") +
            "</div>" +
            '<details class="issue-drawer" data-ms="' +
            esc(m.id) +
            '"' +
            (isOpen ? " open" : "") +
            ">" +
            '<summary data-focus-key="ms-summary-' +
            esc(m.id) +
            '">Issues (' +
            m.issues.length +
            ")</summary>" +
            issuesHtml +
            "</details>" +
            "</article>"
          );
        })
        .join("") + unassignedCardHtml;

    updateSectionHtml("milestones-grid", milestonesHtml, (grid) => {
      grid.querySelectorAll("details.issue-drawer").forEach((d) => {
        d.addEventListener("toggle", () => {
          const id = d.getAttribute("data-ms");
          if (d.open) state.openDrawers.add(id);
          else state.openDrawers.delete(id);
        });
      });
    });

    const filteredPrs = snap.openPulls.filter((pr) => {
      if (state.prFilter === "queue") {
        return Boolean(
          pr.mergeQueue &&
            (pr.mergeQueue.queued === true || pr.mergeQueue.known === false),
        );
      }
      if (state.prFilter === "fail") return pr.ci.state === "FAIL";
      if (state.prFilter === "pending") return pr.ci.state === "PENDING";
      if (state.prFilter === "pass") return pr.ci.state === "PASS";
      return true;
    });

    const openPrsHtml =
      filteredPrs.length === 0
        ? '<div class="empty-state">No open pull requests match the current filter.</div>'
        : "<table><thead><tr>" +
          "<th>PR</th><th>Milestone</th><th>Branch</th><th>CI Checks</th><th>Review</th><th>Merge / Queue</th>" +
          "</tr></thead><tbody>" +
          filteredPrs
            .map(
              (pr) =>
                "<tr>" +
                '<td><a data-focus-key="open-pr-' +
                pr.number +
                '" href="' +
                safeHref(pr.url) +
                '" target="_blank" rel="noopener noreferrer"><span class="mono">#' +
                pr.number +
                "</span> " +
                esc(pr.title) +
                "</a></td>" +
                "<td>" +
                (pr.milestoneId
                  ? '<span class="pill mono">' + esc(pr.milestoneId) + "</span>"
                  : '<span class="pill muted">—</span>') +
                "</td>" +
                "<td><code>" +
                esc(pr.headRefName || "—") +
                "</code></td>" +
                "<td>" +
                ciBadge(pr.ci) +
                "</td>" +
                "<td>" +
                reviewBadge(pr.reviewStatus) +
                "</td>" +
                "<td>" +
                queueBadge(pr) +
                "</td>" +
                "</tr>",
            )
            .join("") +
          "</tbody></table>";
    updateSectionHtml("open-prs-wrap", openPrsHtml);

    const mergedPrsHtml =
      snap.mergedPulls.length === 0
        ? '<div class="empty-state">No recently updated merged pull requests.</div>'
        : "<table><thead><tr>" +
          "<th>PR</th><th>Milestone</th><th>Branch</th><th>Merged At</th>" +
          "</tr></thead><tbody>" +
          snap.mergedPulls
            .map(
              (pr) =>
                "<tr>" +
                '<td><a data-focus-key="merged-pr-' +
                pr.number +
                '" href="' +
                safeHref(pr.url) +
                '" target="_blank" rel="noopener noreferrer"><span class="mono">#' +
                pr.number +
                "</span> " +
                esc(pr.title) +
                "</a></td>" +
                "<td>" +
                (pr.milestoneId
                  ? '<span class="pill mono">' + esc(pr.milestoneId) + "</span>"
                  : '<span class="pill muted">—</span>') +
                "</td>" +
                "<td><code>" +
                esc(pr.headRefName || "—") +
                "</code></td>" +
                '<td class="mono">' +
                esc(fmtTime(pr.mergedAt)) +
                "</td>" +
                "</tr>",
            )
            .join("") +
          "</tbody></table>";
    updateSectionHtml("merged-prs-wrap", mergedPrsHtml);
  }

  async function postJson(path, body) {
    await fetchImpl(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Factory-Board-Token": boardToken,
      },
      body: JSON.stringify(body),
    });
  }

  el("refresh-now").addEventListener("click", async () => {
    if (state.refreshing) return;
    state.refreshing = true;
    const btn = el("refresh-now");
    btn.disabled = true;
    btn.textContent = "Refreshing…";
    try {
      await postJson("/api/refresh", {});
    } finally {
      state.refreshing = false;
      btn.disabled = false;
      btn.textContent = "Refresh now";
    }
  });

  el("toggle-pause").addEventListener("click", async () => {
    const currentlyPaused = Boolean(state.envelope?.config?.paused);
    await postJson("/api/control", { paused: !currentlyPaused });
  });

  el("interval-select").addEventListener("change", async (ev) => {
    const val = Number.parseInt(ev.target.value, 10);
    if (Number.isSafeInteger(val)) {
      await postJson("/api/control", { intervalSeconds: val });
    }
  });

  const syncFilterButtons = () => {
    el("pr-filters")
      .querySelectorAll("button")
      .forEach((b) => {
        const selected = b.getAttribute("data-filter") === state.prFilter;
        b.classList.toggle("active", selected);
        b.setAttribute("aria-pressed", selected ? "true" : "false");
      });
  };
  syncFilterButtons();

  el("pr-filters").addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-filter]");
    if (!btn) return;
    state.prFilter = btn.getAttribute("data-filter");
    syncFilterButtons();
    render();
  });

  const pullLatestState = () =>
    fetchImpl("/api/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data) {
          applyEnvelope(data);
        }
      })
      .catch(() => {});

  const source = new EventSourceImpl("/events");
  source.addEventListener("open", () => setSseState("live", "Live SSE"));
  source.addEventListener("error", () => setSseState("error", "Reconnecting…"));
  source.addEventListener("state", (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      setSseState("live", "Live SSE");
      applyEnvelope(parsed);
    } catch {
      setSseState("error", "Stream parse error");
    }
  });
  source.addEventListener("state_notify", () => {
    setSseState("live", "Live SSE");
    void pullLatestState();
  });

  fetchImpl("/api/state")
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && !state.envelope) {
        applyEnvelope(data);
      }
    })
    .catch(() => {});

  return { state, render, safeHref, fmtTime, ciBadge, reviewBadge, queueBadge };
}

export function renderBoardHtml({
  title = CANVAS_DISPLAY_NAME,
  repo = DEFAULT_REPO,
  boardToken = "",
  staticPages = false,
} = {}) {
  const safeTitle = escapeHtml(title);
  const safeRepo = escapeHtml(repo);
  const safeToken = escapeHtml(boardToken);
  const cspMeta = staticPages
    ? `\n  <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://api.github.com; img-src 'self' data:; object-src 'none'; base-uri 'self'" />`
    : "";
  const bodyAttrs = staticPages
    ? `data-board-token="${safeToken}" data-static-pages="true" data-repo="${safeRepo}"`
    : `data-board-token="${safeToken}"`;
  const scriptSrc = staticPages ? "./client.mjs" : "/client.mjs";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />${cspMeta}
  <title>${safeTitle}</title>
  <style>
    :root {
      --status-bar-color: var(--background-color-default, #ffffff);
      --board-bg: var(--background-color-default, #ffffff);
      --board-border: var(--border-color-default, #d0d7de);
      --board-text: var(--text-color-default, #1f2328);
      --board-muted: var(--text-color-muted, #59636e);
      --board-focus: var(--color-focus-outline, #0969da);
      --board-blue: var(--true-color-blue, #0969da);
      --board-blue-soft: var(--true-color-blue-muted, rgba(9, 105, 218, 0.12));
      --board-red: var(--true-color-red, #d1242f);
      --board-red-soft: var(--true-color-red-muted, rgba(209, 36, 47, 0.12));
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 0;
      background: var(--board-bg);
      color: var(--board-text);
      font-family: var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
      font-size: var(--text-body-medium, 14px);
      line-height: var(--leading-body-medium, 20px);
    }
    .board-shell {
      max-width: 1280px;
      margin: 0 auto;
      padding: 16px 20px 32px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .topbar {
      position: sticky;
      top: 0;
      z-index: 10;
      background: var(--board-bg);
      border-bottom: 1px solid var(--board-border);
      padding: 12px 0;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .title-group { display: flex; flex-direction: column; gap: 4px; }
    h1 {
      margin: 0;
      font-family: var(--font-sans-display, var(--font-sans, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif));
      font-size: var(--text-title-large, 22px);
      font-weight: var(--font-weight-semibold, 600);
      line-height: var(--leading-title-large, 28px);
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .meta-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: var(--board-muted); font-size: 12px; }
    .controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    button, select {
      appearance: none;
      background: var(--board-bg);
      color: var(--board-text);
      border: 1px solid var(--board-border);
      border-radius: 6px;
      padding: 6px 11px;
      font-family: inherit;
      font-size: 12px;
      font-weight: var(--font-weight-semibold, 600);
      cursor: pointer;
    }
    button:hover, select:hover { border-color: var(--board-blue); }
    button:focus-visible, select:focus-visible, a:focus-visible, summary:focus-visible {
      outline: 2px solid var(--board-focus);
      outline-offset: 2px;
    }
    button.primary { background: var(--board-blue); border-color: var(--board-blue); color: var(--color-white, #ffffff); }
    button[disabled] { opacity: 0.6; cursor: default; }
    .pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--board-border);
      font-size: 11px;
      font-weight: var(--font-weight-semibold, 600);
      white-space: nowrap;
    }
    .pill.blue { background: var(--board-blue-soft); color: var(--board-blue); border-color: var(--board-blue); }
    .pill.red { background: var(--board-red-soft); color: var(--board-red); border-color: var(--board-red); }
    .pill.muted { color: var(--board-muted); }
    .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--board-muted); display: inline-block; }
    .dot.live { background: var(--board-blue); }
    .dot.error { background: var(--board-red); }
    code, .mono { font-family: var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace); font-size: var(--text-code-inline, 12px); }
    .banner { border: 1px solid var(--board-red); background: var(--board-red-soft); color: var(--board-red); border-radius: 8px; padding: 10px 14px; font-size: 13px; }
    .banner[hidden] { display: none; }
    .kpi-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 10px; }
    .kpi-card { border: 1px solid var(--board-border); border-radius: 8px; padding: 12px 14px; display: flex; flex-direction: column; gap: 4px; }
    .kpi-label { color: var(--board-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; font-weight: var(--font-weight-semibold, 600); }
    .kpi-value { font-size: 20px; font-weight: var(--font-weight-semibold, 600); line-height: 24px; }
    .kpi-sub { color: var(--board-muted); font-size: 12px; }
    .section-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    h2 { margin: 0; font-size: 15px; font-weight: var(--font-weight-semibold, 600); }
    .milestones-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
    .milestone-card { border: 1px solid var(--board-border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
    .milestone-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .milestone-title { font-weight: var(--font-weight-semibold, 600); font-size: 14px; }
    .progress-track { width: 100%; height: 8px; border-radius: 999px; border: 1px solid var(--board-border); overflow: hidden; background: transparent; }
    .progress-fill { height: 100%; background: var(--board-blue); transition: width 200ms ease; }
    .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
    details.issue-drawer { border-top: 1px solid var(--board-border); padding-top: 8px; }
    details.issue-drawer summary { cursor: pointer; font-size: 12px; color: var(--board-muted); font-weight: var(--font-weight-semibold, 600); user-select: none; }
    .issue-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .issue-item { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; padding: 6px 8px; border: 1px solid var(--board-border); border-radius: 6px; font-size: 12px; }
    .issue-main { display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1 1 200px; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    a { color: var(--board-blue); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .filter-tabs { display: flex; flex-wrap: wrap; gap: 6px; }
    .filter-tabs button.active { border-color: var(--board-blue); background: var(--board-blue-soft); color: var(--board-blue); }
    .table-wrap { border: 1px solid var(--board-border); border-radius: 10px; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--board-border); vertical-align: middle; }
    th { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--board-muted); font-weight: var(--font-weight-semibold, 600); }
    tr:last-child td { border-bottom: none; }
    .empty-state { padding: 18px; text-align: center; color: var(--board-muted); font-size: 13px; }
  </style>
</head>
  <body ${bodyAttrs}>
  <div class="board-shell">
    <header class="topbar">
      <div class="title-group">
        <h1>
          <span>${safeTitle}</span>
          <span class="pill mono" id="repo-pill">${safeRepo}</span>
          <span class="pill muted">Read-only</span>
        </h1>
        <div class="meta-row">
          <span class="pill" id="sse-pill"><span class="dot" id="sse-dot"></span><span id="sse-text">Connecting…</span></span>
          <span id="source-text">Source: loading</span>
          <span>•</span>
          <span id="status-text">Auto-refreshing</span>
          <span>•</span>
          <span id="updated-text">Waiting for snapshot…</span>
        </div>
      </div>
      <div class="controls">
        <label for="interval-select" class="meta-row">Interval</label>
        <select id="interval-select" aria-label="Auto-refresh interval">
          <option value="10">10s</option>
          <option value="20" selected>20s</option>
          <option value="30">30s</option>
          <option value="60">60s</option>
          <option value="120">120s</option>
          <option value="300">300s</option>
        </select>
        <button type="button" id="toggle-pause" aria-pressed="false">Pause auto-refresh</button>
        <button type="button" id="refresh-now" class="primary">Refresh now</button>
      </div>
    </header>
    <div id="error-banner" class="banner" role="alert" hidden></div>
    <section aria-label="Summary metrics">
      <div class="kpi-grid" id="kpi-grid"></div>
    </section>
    <section aria-label="Milestone progress">
      <div class="section-header">
        <h2>Milestones (M01–M05)</h2>
        <span class="meta-row">Closed issues (activity proxy, not verified acceptance) are shown separately from active open PRs</span>
      </div>
      <div class="milestones-grid" id="milestones-grid"></div>
    </section>
    <section aria-label="Open pull requests">
      <div class="section-header">
        <h2>Open Pull Requests &amp; Merge Queue</h2>
        <div class="filter-tabs" id="pr-filters">
          <button type="button" data-filter="all" class="active" aria-pressed="true">All</button>
          <button type="button" data-filter="queue" aria-pressed="false">Merge Queue</button>
          <button type="button" data-filter="fail" aria-pressed="false">CI Failing</button>
          <button type="button" data-filter="pending" aria-pressed="false">CI Pending</button>
          <button type="button" data-filter="pass" aria-pressed="false">CI Passing</button>
        </div>
      </div>
      <div class="table-wrap" id="open-prs-wrap"></div>
    </section>
    <section aria-label="Recently updated merged pull requests">
      <div class="section-header">
        <h2>Recently Updated Merged Pull Requests</h2>
      </div>
      <div class="table-wrap" id="merged-prs-wrap"></div>
    </section>
  </div>
  <script type="module" src="${scriptSrc}"></script>
</body>
</html>`;
}

export function createStaticPagesHost(win, { defaultIntervalSeconds = 60 } = {}) {
  const doc = win.document;
  const realFetch = win.fetch.bind(win);
  const setTimer = (fn, ms) => (win.setInterval ? win.setInterval(fn, ms) : setInterval(fn, ms));
  const clearTimer = (id) => (win.clearInterval ? win.clearInterval(id) : clearInterval(id));
  const nowFn = win.Date ? () => win.Date.now() : Date.now;
  const repo = doc.body.getAttribute("data-repo") || "Jamula/SoftwareFactory";
  const listeners = new Map();

  let seq = 0;
  let intervalSeconds = defaultIntervalSeconds;
  let paused = false;
  let snapshot = null;
  let blockedUntilMs = 0;
  let timer = null;
  let inFlightRefresh = null;

  const statusText = () => (paused ? "Paused" : `Auto-refreshing (${intervalSeconds}s)`);
  const currentEnvelope = () => ({
    seq,
    config: { repo, intervalSeconds, paused, status: statusText() },
    snapshot,
  });

  function emit(eventName, payload) {
    const fn = listeners.get(eventName);
    if (fn) {
      fn(payload);
    }
  }

  function pushState() {
    seq += 1;
    emit("state", { data: JSON.stringify(currentEnvelope()) });
  }

  function markDegradedSnapshot(code, message) {
    if (snapshot && snapshot.verified) {
      snapshot = {
        ...snapshot,
        ok: false,
        stale: true,
        error: { code, message },
        lastAttemptAt: new Date(nowFn()).toISOString(),
      };
      pushState();
    }
    emit("error", {});
  }

  function inferRestMilestoneId(nativeTitle, labels, title, codeRe) {
    if (nativeTitle && !/^historical\b/i.test(nativeTitle.trim())) {
      const m = codeRe.exec(nativeTitle);
      if (m) return m[1].toUpperCase();
    }
    for (const label of labels) {
      const m = codeRe.exec(label);
      if (m) return m[1].toUpperCase();
    }
    const tm = codeRe.exec(title);
    return tm ? tm[1].toUpperCase() : null;
  }

  function summarizeRestChecks(runs) {
    if (!runs) {
      return { state: "UNKNOWN", passed: 0, failed: 0, pending: 0, total: 0 };
    }
    if (runs.length === 0) {
      return { state: "PENDING", passed: 0, failed: 0, pending: 0, total: 0 };
    }
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const run of runs) {
      if (run.status !== "completed") {
        pending += 1;
      } else if (run.conclusion === "success" || run.conclusion === "neutral" || run.conclusion === "skipped") {
        passed += 1;
      } else {
        failed += 1;
      }
    }
    const state = failed > 0 ? "FAIL" : pending > 0 ? "PENDING" : "PASS";
    return { state, passed, failed, pending, total: runs.length };
  }

  function mapStaticRestSnapshot(milestonesRaw, issuesOnlyRaw, openPullsRaw, closedPullsRaw, checkRunsBySha, partial) {
    const canonicalIds = [
      ["M01", "M01 - Autonomous SoftwareFactory"],
      ["M02", "M02 - Fast SoftwareFactory"],
      ["M03", "M03 - FamilyTree autonomous adoption"],
      ["M04", "M04 - Spellbook autonomous adoption"],
      ["M05", "M05 - FamilyHub autonomous adoption"],
    ];
    const codeRe = /\b(M0[1-5])\b/i;
    const byId = new Map(
      canonicalIds.map(([id, title]) => [
        id,
        {
          id,
          number: null,
          title,
          state: "missing",
          openIssues: 0,
          closedIssues: 0,
          totalIssues: 0,
          completionPercent: partial ? null : 0,
          activePulls: 0,
          ciPassingPulls: 0,
          ciPendingPulls: 0,
          ciFailingPulls: 0,
          queuedPulls: null,
          issues: [],
        },
      ]),
    );
    for (const m of milestonesRaw) {
      const match = codeRe.exec(m.title);
      if (match && !/^historical\b/i.test(m.title.trim())) {
        const slot = byId.get(match[1].toUpperCase());
        slot.number = typeof m.number === "number" ? m.number : null;
        slot.title = m.title;
        slot.state = m.state.toLowerCase();
      }
    }
    const unassignedIssues = [];
    const issueMilestoneMap = new Map();
    let issuesOpen = 0;
    let issuesClosed = 0;
    for (const it of issuesOnlyRaw) {
      const state = it.state.toUpperCase();
      if (state === "CLOSED") issuesClosed += 1;
      else issuesOpen += 1;
      const labels = it.labels.map((l) => (typeof l === "string" ? l : l.name));
      const milestoneId = inferRestMilestoneId(it.milestone ? it.milestone.title : "", labels, it.title, codeRe);
      const prioMatch = labels.find((l) => /^P[0-2]$/i.test(l));
      const row = {
        number: it.number,
        title: it.title,
        state,
        priority: prioMatch ? prioMatch.toUpperCase() : null,
        milestoneId,
        stepId: null,
        labels,
        linkedPullNumbers: [],
        url: it.html_url,
        updatedAt: it.updated_at,
      };
      if (milestoneId) {
        issueMilestoneMap.set(it.number, milestoneId);
        const slot = byId.get(milestoneId);
        slot.issues.push(row);
        if (state === "CLOSED") slot.closedIssues += 1;
        else slot.openIssues += 1;
      } else {
        unassignedIssues.push(row);
      }
    }
    const openPulls = [];
    for (const pr of openPullsRaw) {
      const prNativeMs = pr.milestone ? pr.milestone.title : "";
      const linkedNums = [...pr.title.matchAll(/#(\d+)\b/g)].map((m) => Number.parseInt(m[1], 10));
      const directMs = inferRestMilestoneId(prNativeMs, [], pr.title, codeRe);
      const milestoneId = directMs || linkedNums.map((n) => issueMilestoneMap.get(n)).find(Boolean) || null;
      const headSha = pr.head.sha || "";
      const ci = summarizeRestChecks(headSha ? checkRunsBySha.get(headSha) : null);
      if (milestoneId) {
        const slot = byId.get(milestoneId);
        slot.activePulls += 1;
        if (ci.state === "PASS") slot.ciPassingPulls += 1;
        else if (ci.state === "PENDING") slot.ciPendingPulls += 1;
        else if (ci.state === "FAIL") slot.ciFailingPulls += 1;
      }
      openPulls.push({
        number: pr.number,
        title: pr.title,
        url: pr.html_url,
        headRefName: pr.head.ref,
        headSha,
        isDraft: Boolean(pr.draft),
        linkedIssueNumbers: linkedNums,
        milestoneId,
        ci,
        reviewStatus: "UNKNOWN",
        mergeStateStatus: "UNKNOWN",
        autoMerge: Boolean(pr.auto_merge),
        mergeQueue: { known: false, queued: null, state: null, position: null },
        updatedAt: pr.updated_at,
      });
    }
    const mergedPulls = [];
    for (const pr of closedPullsRaw) {
      if (pr.merged_at) {
        const milestoneId = inferRestMilestoneId(pr.milestone ? pr.milestone.title : "", [], pr.title, codeRe);
        mergedPulls.push({
          number: pr.number,
          title: pr.title,
          url: pr.html_url,
          headRefName: pr.head.ref,
          milestoneId,
          mergedAt: pr.merged_at,
        });
      }
    }
    for (const slot of byId.values()) {
      slot.totalIssues = slot.openIssues + slot.closedIssues;
      slot.completionPercent = partial
        ? null
        : slot.totalIssues > 0
          ? Math.round((slot.closedIssues / slot.totalIssues) * 100)
          : 0;
    }
    const issuesTotal = issuesOpen + issuesClosed;
    return {
      repo,
      source: "github-rest",
      readOnly: true,
      verified: true,
      ok: true,
      partial,
      stale: false,
      error: null,
      generatedAt: new Date(nowFn()).toISOString(),
      rateLimit: null,
      totals: {
        milestonesOpen: [...byId.values()].filter((m) => m.state === "open").length,
        issuesOpen,
        issuesClosed,
        issuesTotal,
        completionPercent: partial
          ? null
          : issuesTotal > 0
            ? Math.round((issuesClosed / issuesTotal) * 100)
            : 0,
        openPulls: openPulls.length,
        draftPulls: openPulls.filter((pr) => pr.isDraft).length,
        ciPassingPulls: openPulls.filter((pr) => pr.ci.state === "PASS").length,
        ciPendingPulls: openPulls.filter((pr) => pr.ci.state === "PENDING").length,
        ciFailingPulls: openPulls.filter((pr) => pr.ci.state === "FAIL").length,
        ciUnknownPulls: openPulls.filter((pr) => pr.ci.state === "UNKNOWN").length,
        approvedPulls: null,
        queuedPulls: null,
        mergedRecentPulls: mergedPulls.length,
      },
      milestones: [...byId.values()],
      openPulls,
      mergedPulls,
      unassignedIssues,
    };
  }

  function applyRateLimitDeadline(r) {
    const retryAfter = Number.parseInt(r.headers.get("retry-after") || "", 10);
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      blockedUntilMs = Math.max(blockedUntilMs, nowFn() + retryAfter * 1000);
    }
    const rem = r.headers.get("x-ratelimit-remaining");
    const rst = Number.parseInt(r.headers.get("x-ratelimit-reset") || "", 10);
    if (rem === "0") {
      const target = Number.isFinite(rst) ? rst * 1000 : nowFn() + 60_000;
      blockedUntilMs = Math.max(blockedUntilMs, target);
    } else if (r.status === 403 || r.status === 429) {
      blockedUntilMs = Math.max(blockedUntilMs, nowFn() + 60_000);
    }
  }

  async function doRefreshFromGitHubRest() {
    if (nowFn() < blockedUntilMs) {
      markDegradedSnapshot("RATE_LIMITED", "Cooling down after GitHub API rate limit.");
      return;
    }
    const base = `https://api.github.com/repos/${repo}`;
    const headers = { Accept: "application/vnd.github+json" };
    try {
      const [mRes, iRes, opRes, cpRes] = await Promise.all([
        realFetch(`${base}/milestones?state=all&per_page=100`, { headers }),
        realFetch(`${base}/issues?state=all&per_page=100&page=1`, { headers }),
        realFetch(`${base}/pulls?state=open&sort=updated&direction=desc&per_page=100`, { headers }),
        realFetch(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=50`, { headers }),
      ]);
      const responses = [mRes, iRes, opRes, cpRes];
      let hasNextPage = false;
      let issuesHasNext = false;
      for (const r of responses) {
        applyRateLimitDeadline(r);
        const linkHeader = r.headers.get("link") || "";
        if (/\brel="next"/i.test(linkHeader)) {
          if (r === iRes) issuesHasNext = true;
          else hasNextPage = true;
        }
      }
      if (responses.some((r) => !r.ok)) {
        markDegradedSnapshot("HTTP_ERROR", "GitHub REST refresh returned a non-OK response.");
        return;
      }
      const [mJson, iPage1, opJson, cpJson] = await Promise.all(responses.map((r) => r.json()));
      let allIssuesRaw = iPage1;
      if (issuesHasNext) {
        const iRes2 = await realFetch(`${base}/issues?state=all&per_page=100&page=2`, { headers });
        applyRateLimitDeadline(iRes2);
        if (!iRes2.ok) {
          markDegradedSnapshot("HTTP_ERROR", "GitHub REST page 2 refresh failed.");
          return;
        }
        if (/\brel="next"/i.test(iRes2.headers.get("link") || "")) {
          hasNextPage = true;
        }
        const iPage2 = await iRes2.json();
        allIssuesRaw = [...iPage1, ...iPage2];
      }
      const checkRunsBySha = new Map();
      const headShas = opJson
        .map((pr) => pr.head.sha)
        .filter(Boolean)
        .slice(0, 8);
      if (headShas.length > 0) {
        const checkResponses = await Promise.all(
          headShas.map((sha) => realFetch(`${base}/commits/${sha}/check-runs?per_page=100`, { headers })),
        );
        for (let idx = 0; idx < headShas.length; idx += 1) {
          const cr = checkResponses[idx];
          applyRateLimitDeadline(cr);
          if (cr.ok) {
            const cj = await cr.json();
            checkRunsBySha.set(headShas[idx], cj.check_runs);
          }
        }
      }
      const issuesOnly = allIssuesRaw.filter((item) => !item.pull_request);
      snapshot = mapStaticRestSnapshot(mJson, issuesOnly, opJson, cpJson, checkRunsBySha, hasNextPage);
      emit("open", {});
      pushState();
    } catch {
      markDegradedSnapshot("NETWORK_ERROR", "Live GitHub REST refresh failed.");
    }
  }

  function refreshFromGitHubRest() {
    if (!inFlightRefresh) {
      inFlightRefresh = doRefreshFromGitHubRest().finally(() => {
        inFlightRefresh = null;
      });
    }
    return inFlightRefresh;
  }

  function reschedule() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (!paused) {
      timer = setTimer(() => {
        void refreshFromGitHubRest();
      }, intervalSeconds * 1000);
    }
  }

  class StaticEventSource {
    addEventListener(ev, fn) {
      listeners.set(ev, fn);
    }
  }

  async function staticFetch(path, opts) {
    if (path === "/api/state") {
      if (!snapshot) {
        try {
          const snapRes = await realFetch("./snapshot.json", { cache: "no-store" });
          if (snapRes.ok) {
            const loaded = await snapRes.json();
            snapshot = loaded?.snapshot ?? loaded;
            if (Number.isSafeInteger(loaded?.config?.intervalSeconds)) {
              intervalSeconds = loaded.config.intervalSeconds;
            }
          }
        } catch {
          // Fall back to live REST poll below
        }
      }
      emit("open", {});
      if (!snapshot) {
        await refreshFromGitHubRest();
      }
      reschedule();
      return new Response(JSON.stringify(currentEnvelope()), { status: 200 });
    }
    if (path === "/api/refresh") {
      await refreshFromGitHubRest();
      return new Response(JSON.stringify(currentEnvelope()), { status: 200 });
    }
    if (path === "/api/control") {
      const body = JSON.parse(opts?.body || "{}");
      if (Number.isSafeInteger(body.intervalSeconds) && body.intervalSeconds >= 10 && body.intervalSeconds <= 300) {
        intervalSeconds = body.intervalSeconds;
      }
      if (typeof body.paused === "boolean") {
        paused = body.paused;
      }
      reschedule();
      pushState();
      return new Response(JSON.stringify(currentEnvelope()), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }

  return {
    document: doc,
    EventSource: StaticEventSource,
    fetch: staticFetch,
    stop: () => {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    },
  };
}

export function buildStaticBoardPagesBundle({
  outputDir,
  repo = DEFAULT_REPO,
  snapshot = null,
  intervalSeconds = 60,
  generatedAt = new Date().toISOString(),
} = {}) {
  if (typeof outputDir !== "string" || outputDir.trim().length === 0 || outputDir.includes("\0")) {
    throw new Error("INVALID_OUTPUT_DIR");
  }
  const parsedRepo = parseRepoSlug(repo);
  const validatedInterval = validateIntervalSeconds(intervalSeconds);
  if (!validatedInterval.valid) {
    throw new Error(validatedInterval.message);
  }
  const resolvedDir = resolve(outputDir);
  mkdirSync(resolvedDir, { recursive: true });

  const effectiveSnapshot =
    snapshot ??
    buildUnavailableSnapshot({
      repo: parsedRepo.fullName,
      generatedAt,
      error: { code: "STATIC_COLD_START", message: "Refreshing live state from GitHub REST API…" },
      previousSnapshot: null,
    });

  const envelope = {
    seq: 1,
    config: {
      repo: parsedRepo.fullName,
      intervalSeconds: validatedInterval.intervalSeconds,
      paused: false,
      status: formatBoardStatus(validatedInterval.intervalSeconds, false),
    },
    snapshot: effectiveSnapshot,
  };

  const indexHtml = renderBoardHtml({
    title: CANVAS_DISPLAY_NAME,
    repo: parsedRepo.fullName,
    boardToken: "",
    staticPages: true,
  });
  const clientJs =
    `const createStaticPagesHost = ${createStaticPagesHost.toString()};\n` +
    `const initFactoryBoardClient = ${initFactoryBoardClient.toString()};\n` +
    `initFactoryBoardClient(createStaticPagesHost(window, { defaultIntervalSeconds: ${validatedInterval.intervalSeconds} }));\n`;

  const indexPath = join(resolvedDir, "index.html");
  const clientPath = join(resolvedDir, "client.mjs");
  const snapshotPath = join(resolvedDir, "snapshot.json");
  const nojekyllPath = join(resolvedDir, ".nojekyll");

  writeFileSync(indexPath, indexHtml, "utf8");
  writeFileSync(clientPath, clientJs, "utf8");
  writeFileSync(snapshotPath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
  writeFileSync(nojekyllPath, "", "utf8");

  return {
    outputDir: resolvedDir,
    repo: parsedRepo.fullName,
    intervalSeconds: validatedInterval.intervalSeconds,
    files: [indexPath, clientPath, snapshotPath, nojekyllPath],
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(body);
}

function readBoundedBody(req, maxBytes = MAX_POST_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > maxBytes) {
        settled = true;
        reject(Object.assign(new Error("Request body too large."), { statusCode: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (raw.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(Object.assign(new Error("Body must be a JSON object."), { statusCode: 400 }));
          return;
        }
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error("Invalid JSON body."), { statusCode: 400 }));
      }
    });
    req.on("error", (err) => {
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

const DEFAULT_CANVAS_FRAME_ANCESTORS = Object.freeze([
  "'self'",
  "tauri://localhost",
  "https://tauri.localhost",
  "http://tauri.localhost",
  "app://localhost",
]);

function isApprovedParentOrigin(raw, expectedOrigin) {
  try {
    const parsed = new URL(raw);
    if (parsed.origin === expectedOrigin) {
      return true;
    }
    if (parsed.protocol === "tauri:" || parsed.protocol === "app:") {
      return parsed.hostname === "localhost";
    }
    return parsed.hostname === "tauri.localhost";
  } catch {
    return false;
  }
}

export function createSseClientRegistry({
  timers = { setInterval, clearInterval },
  maxBufferBytes = MAX_SSE_BUFFER_BYTES,
} = {}) {
  const clients = new Map();

  function remove(res) {
    const client = clients.get(res);
    if (!client) {
      return;
    }
    timers.clearInterval(client.keepAlive);
    clients.delete(res);
  }

  function write(res, frame, { isState = false } = {}) {
    const client = clients.get(res);
    if (!client || res.destroyed || res.writableEnded) {
      remove(res);
      return;
    }
    if ((res.writableLength ?? 0) > maxBufferBytes) {
      remove(res);
      res.destroy();
      return;
    }
    const wireFrame =
      isState && Buffer.byteLength(frame) > maxBufferBytes
        ? 'event: state_notify\ndata: {"pull":true}\n\n'
        : frame;
    if (client.waitingDrain) {
      if (isState) {
        client.pendingStateFrame = wireFrame;
      }
      return;
    }
    const flushed = res.write(wireFrame);
    if (!flushed) {
      if ((res.writableLength ?? 0) > maxBufferBytes) {
        remove(res);
        res.destroy();
        return;
      }
      client.waitingDrain = true;
      res.once("drain", () => {
        client.waitingDrain = false;
        const nextFrame = client.pendingStateFrame;
        client.pendingStateFrame = null;
        if (nextFrame !== null) {
          write(res, nextFrame, { isState: true });
        }
      });
    }
  }

  function add(res, keepAlive) {
    clients.set(res, { keepAlive, waitingDrain: false, pendingStateFrame: null });
  }

  function broadcastState(frame) {
    for (const res of [...clients.keys()]) {
      write(res, frame, { isState: true });
    }
  }

  function closeAll() {
    for (const [res, client] of clients.entries()) {
      timers.clearInterval(client.keepAlive);
      if (!res.writableEnded) {
        res.end();
      }
    }
    clients.clear();
  }

  return { add, remove, write, broadcastState, closeAll, size: () => clients.size };
}

export async function startLoopbackBoardServer({
  repo = DEFAULT_REPO,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  fetchSnapshot = fetchFactoryBoardSnapshot,
  timers,
  onLog,
  observe = noopObserve,
  maxSseBufferBytes = MAX_SSE_BUFFER_BYTES,
  standalone = false,
  frameAncestors = standalone ? ["'none'"] : DEFAULT_CANVAS_FRAME_ANCESTORS,
} = {}) {
  const runtimeTimers = timers ?? { setInterval, clearInterval };
  const frameAncestorsDirective =
    Array.isArray(frameAncestors) && frameAncestors.length > 0
      ? frameAncestors.join(" ")
      : "'none'";
  const cspHeader = `default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors ${frameAncestorsDirective}; base-uri 'self'; object-src 'none'`;
  const normalizedRepo = parseRepoSlug(repo).fullName;
  const poller = createBoardPoller({
    repo: normalizedRepo,
    intervalSeconds,
    fetchSnapshot,
    timers: runtimeTimers,
    observe,
  });

  const sockets = new Set();
  const sseRegistry = createSseClientRegistry({
    timers: runtimeTimers,
    maxBufferBytes: maxSseBufferBytes,
  });
  const boardToken = randomBytes(16).toString("hex");
  const html = renderBoardHtml({
    title: CANVAS_DISPLAY_NAME,
    repo: normalizedRepo,
    boardToken,
  });
  const clientJs = `(${initFactoryBoardClient.toString()})(window);\n`;

  let expectedHost = "";
  let expectedOrigin = "";

  const unsubscribe = poller.subscribe((envelope) => {
    sseRegistry.broadcastState(`event: state\ndata: ${JSON.stringify(envelope)}\n\n`);
  });

  const server = createServer(async (req, res) => {
    try {
      const hostHeader = typeof req.headers.host === "string" ? req.headers.host.toLowerCase() : "";
      if (hostHeader !== expectedHost) {
        sendJson(res, 403, {
          error: "FORBIDDEN_HOST",
          message: "Request Host header does not match bound loopback authority.",
        });
        return;
      }

      const originHeader = req.headers.origin;
      if (typeof originHeader === "string" && originHeader !== expectedOrigin) {
        sendJson(res, 403, {
          error: "FORBIDDEN_ORIGIN",
          message: "Cross-origin requests are forbidden.",
        });
        return;
      }

      const url = new URL(req.url ?? "/", expectedOrigin);
      const pathname = url.pathname;
      const method = req.method ?? "GET";
      const fetchSite = req.headers["sec-fetch-site"];
      const fetchDest = req.headers["sec-fetch-dest"];

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        const refererHeader = req.headers.referer;
        if (
          (fetchDest === "iframe" && frameAncestorsDirective === "'none'") ||
          (typeof refererHeader === "string" &&
            !isApprovedParentOrigin(refererHeader, expectedOrigin)) ||
          (fetchSite === "cross-site" && fetchDest !== "iframe")
        ) {
          sendJson(res, 403, {
            error: "FORBIDDEN_FRAME_ORIGIN",
            message: "Unapproved cross-site framing or navigation is forbidden.",
          });
          return;
        }
        const headers = {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": cspHeader,
        };
        if (frameAncestorsDirective === "'none'") {
          headers["X-Frame-Options"] = "DENY";
        }
        res.writeHead(200, headers);
        res.end(html);
        return;
      }

      if (typeof fetchSite === "string" && fetchSite === "cross-site") {
        sendJson(res, 403, {
          error: "FORBIDDEN_FETCH_SITE",
          message: "Cross-site subresource requests are forbidden.",
        });
        return;
      }

      if (method === "GET" && pathname === "/client.mjs") {
        res.writeHead(200, {
          "Content-Type": "text/javascript; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(clientJs);
        return;
      }

      if (method === "GET" && pathname === "/api/state") {
        let current = poller.getState();
        if (!current.snapshot) {
          current = await poller.refresh();
        }
        sendJson(res, 200, current);
        return;
      }

      if (method === "POST" && (pathname === "/api/refresh" || pathname === "/api/control")) {
        const contentType = req.headers["content-type"] ?? "";
        if (!/^application\/json\b/i.test(contentType)) {
          sendJson(res, 415, {
            error: "UNSUPPORTED_MEDIA_TYPE",
            message: "Content-Type must be application/json.",
          });
          return;
        }
        if (req.headers["x-factory-board-token"] !== boardToken) {
          sendJson(res, 403, {
            error: "FORBIDDEN_TOKEN",
            message: "Missing or invalid board capability token.",
          });
          return;
        }
        const body = await readBoundedBody(req);
        if (pathname === "/api/refresh") {
          const refreshed = await poller.refresh();
          sendJson(res, 200, refreshed);
          return;
        }
        if (body.intervalSeconds !== undefined) {
          const check = poller.setIntervalSeconds(body.intervalSeconds);
          if (!check.valid) {
            sendJson(res, 400, { error: check.reason, message: check.message });
            return;
          }
        }
        if (typeof body.paused === "boolean") {
          poller.setPaused(body.paused);
        }
        sendJson(res, 200, poller.getState());
        return;
      }

      if (method === "GET" && pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Content-Type-Options": "nosniff",
        });
        res.flushHeaders();

        const keepAlive = runtimeTimers.setInterval(() => {
          sseRegistry.write(res, ": keepalive\n\n");
        }, SSE_KEEPALIVE_MS);
        keepAlive.unref?.();

        sseRegistry.add(res, keepAlive);
        sseRegistry.write(res, `event: state\ndata: ${JSON.stringify(poller.getState())}\n\n`, {
          isState: true,
        });
        if (!poller.getState().snapshot) {
          void poller.refresh();
        }

        const onStreamClosed = () => sseRegistry.remove(res);
        req.on("close", onStreamClosed);
        res.on("close", onStreamClosed);
        return;
      }

      sendJson(res, 404, { error: "NOT_FOUND", message: "Unknown endpoint." });
    } catch (err) {
      const statusCode = Number.isSafeInteger(err?.statusCode) ? err.statusCode : 500;
      const message = err instanceof Error ? err.message : "Unexpected server error.";
      onLog?.(`Factory board HTTP error: ${message}`, { level: "warning", ephemeral: true });
      if (!res.headersSent) {
        sendJson(res, statusCode, { error: "REQUEST_FAILED", message });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  expectedHost = `127.0.0.1:${port}`;
  expectedOrigin = `http://127.0.0.1:${port}`;
  const url = `${expectedOrigin}/`;

  void poller.start();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    poller.close();
    sseRegistry.closeAll();
    await new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    });
  }

  return { url, port, boardToken, poller, close };
}

export function createBoardInstanceManager({
  fetchSnapshot = fetchFactoryBoardSnapshot,
  startServer = startLoopbackBoardServer,
  timers,
  onLog,
  observe = noopObserve,
} = {}) {
  const instances = new Map();
  const pendingOpens = new Map();

  async function openInstance(ctx) {
    const instanceId = ctx?.instanceId;
    if (typeof instanceId !== "string" || instanceId.length === 0) {
      throw new Error("Missing canvas instanceId.");
    }
    const requestedInterval = ctx?.input?.intervalSeconds;
    if (requestedInterval !== undefined) {
      const check = validateIntervalSeconds(requestedInterval);
      if (!check.valid) {
        throw Object.assign(new Error(check.message), { code: "invalid_interval" });
      }
    }
    const explicitRepo =
      ctx?.input?.repo !== undefined ? parseRepoSlug(ctx.input.repo).fullName : null;

    let entry = instances.get(instanceId);
    if (entry) {
      const boundRepo = entry.poller.getState().config.repo;
      if (explicitRepo !== null && explicitRepo.toLowerCase() !== boundRepo.toLowerCase()) {
        throw Object.assign(
          new Error(
            `Canvas instance "${instanceId}" is already bound to "${boundRepo}"; cannot reopen with "${explicitRepo}".`,
          ),
          { code: "repo_conflict" },
        );
      }
    } else {
      let pending = pendingOpens.get(instanceId);
      if (pending) {
        if (explicitRepo !== null && explicitRepo.toLowerCase() !== pending.repo.toLowerCase()) {
          throw Object.assign(
            new Error(
              `Canvas instance "${instanceId}" is already opening for "${pending.repo}"; cannot open with "${explicitRepo}".`,
            ),
            { code: "repo_conflict" },
          );
        }
      } else {
        const targetRepo = explicitRepo ?? DEFAULT_REPO;
        const record = { repo: targetRepo, cancelled: false, promise: null };
        record.promise = (async () => {
          try {
            const created = await startServer({
              repo: targetRepo,
              intervalSeconds: requestedInterval ?? DEFAULT_INTERVAL_SECONDS,
              fetchSnapshot,
              timers,
              onLog,
              observe,
            });
            if (record.cancelled) {
              await created.close();
              throw Object.assign(new Error("Canvas instance closed during startup."), {
                code: "open_cancelled",
              });
            }
            instances.set(instanceId, created);
            return created;
          } finally {
            pendingOpens.delete(instanceId);
          }
        })();
        pendingOpens.set(instanceId, record);
        pending = record;
      }
      entry = await pending.promise;
    }

    if (requestedInterval !== undefined) {
      entry.poller.setIntervalSeconds(requestedInterval);
    }

    const { status } = entry.poller.getState().config;
    return {
      title: CANVAS_DISPLAY_NAME,
      status,
      url: entry.url,
    };
  }

  async function closeInstance(instanceId) {
    const pending = pendingOpens.get(instanceId);
    if (pending) {
      pending.cancelled = true;
      await pending.promise.catch(() => {});
    }
    const entry = instances.get(instanceId);
    if (!entry) {
      return Boolean(pending);
    }
    instances.delete(instanceId);
    await entry.close();
    return true;
  }

  async function closeAll() {
    const ids = new Set([...instances.keys(), ...pendingOpens.keys()]);
    await Promise.all([...ids].map((id) => closeInstance(id)));
  }

  async function refreshInstance(instanceId) {
    const entry = instances.get(instanceId);
    if (!entry) {
      return null;
    }
    await entry.poller.refresh();
    return entry.poller.getSummary();
  }

  function setInstanceInterval(instanceId, intervalSeconds) {
    const check = validateIntervalSeconds(intervalSeconds);
    if (!check.valid) {
      return { ok: false, code: "invalid_interval", message: check.message };
    }
    const entry = instances.get(instanceId);
    if (!entry) {
      return {
        ok: false,
        code: "instance_not_found",
        message: `Canvas instance "${instanceId}" is not open.`,
      };
    }
    const updated = entry.poller.setIntervalSeconds(intervalSeconds);
    return {
      ok: true,
      result: {
        instanceId,
        repo: updated.repo,
        intervalSeconds: updated.intervalSeconds,
        paused: updated.paused,
        status: updated.status,
      },
    };
  }

  return {
    openInstance,
    closeInstance,
    closeAll,
    refreshInstance,
    setInstanceInterval,
    size: () => instances.size,
  };
}

export function createFactoryBoardCanvasSpec({ CanvasError, manager }) {
  return {
    id: CANVAS_ID,
    displayName: CANVAS_DISPLAY_NAME,
    description: CANVAS_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        repo: {
          type: "string",
          pattern: "^[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}$",
          description: "GitHub repository in owner/name form (defaults to Jamula/SoftwareFactory).",
        },
        intervalSeconds: {
          type: "integer",
          minimum: 10,
          maximum: 300,
          description: "Initial auto-refresh polling interval in seconds (10 to 300).",
        },
      },
    },
    actions: [
      {
        name: "refresh",
        description: "Refresh the board snapshot immediately and push to connected viewers",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        handler: async (ctx) => {
          const summary = await manager.refreshInstance(ctx.instanceId);
          if (!summary) {
            throw new CanvasError(
              "instance_not_found",
              `Canvas instance "${ctx.instanceId}" is not open.`,
            );
          }
          return summary;
        },
      },
      {
        name: "set_interval",
        description: "Update auto-refresh interval in seconds (10 to 300)",
        inputSchema: {
          type: "object",
          required: ["intervalSeconds"],
          additionalProperties: false,
          properties: {
            intervalSeconds: {
              type: "integer",
              description: "Auto-refresh interval in seconds (10 to 300).",
            },
          },
        },
        handler: async (ctx) => {
          const outcome = manager.setInstanceInterval(
            ctx.instanceId,
            ctx.input?.intervalSeconds,
          );
          if (!outcome.ok) {
            throw new CanvasError(outcome.code, outcome.message);
          }
          return outcome.result;
        },
      },
    ],
    open: async (ctx) => {
      try {
        return await manager.openInstance(ctx);
      } catch (err) {
        const code = typeof err?.code === "string" ? err.code : "open_failed";
        const message = err instanceof Error ? err.message : "Unable to open Factory Board canvas.";
        throw new CanvasError(code, message);
      }
    },
    onClose: async (ctx) => {
      await manager.closeInstance(ctx.instanceId);
    },
  };
}

export async function startFactoryBoardExtension({
  CanvasError,
  createCanvas,
  joinSession,
  createManager = createBoardInstanceManager,
  env = process.env,
  startTelemetry = startLocalSdk,
}) {
  let activeSession = null;
  const endpoint = env?.OTEL_EXPORTER_OTLP_ENDPOINT;
  const telemetry =
    typeof endpoint === "string" && endpoint.trim().length > 0
      ? await startTelemetry(
          {
            endpoint,
            protocol: env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf",
            headers: env.OTEL_EXPORTER_OTLP_HEADERS,
          },
          undefined,
          env,
        ).catch(() => null)
      : null;

  const manager = createManager({
    observe: telemetry?.observe,
    onLog: (message, options) => {
      if (activeSession && typeof activeSession.log === "function") {
        activeSession.log(message, options);
      }
    },
  });

  try {
    const canvas = createCanvas(createFactoryBoardCanvasSpec({ CanvasError, manager }));

    activeSession = await joinSession({
      canvases: {
        definitions: [canvas],
      },
      hooks: {
        handlers: {
          onSessionEnd: async () => {
            await manager.closeAll();
            if (telemetry) {
              await telemetry.shutdown().catch(() => {});
            }
          },
        },
      },
    });

    return { session: activeSession, manager, canvas };
  } catch (err) {
    await manager.closeAll().catch(() => {});
    if (telemetry) {
      await telemetry.shutdown().catch(() => {});
    }
    throw err;
  }
}
