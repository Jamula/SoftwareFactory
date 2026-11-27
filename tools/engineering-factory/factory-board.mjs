import { execFile } from "node:child_process";

export const DEFAULT_REPO = "Jamula/SoftwareFactory";
export const DEFAULT_INTERVAL_SECONDS = 20;
export const MIN_INTERVAL_SECONDS = 10;
export const MAX_INTERVAL_SECONDS = 300;
export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_BYTES = 1_048_576;

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
const ISSUE_REF_PATTERN = /#(\d+)\b/g;

const GRAPHQL_SNAPSHOT_QUERY = [
  "query($owner:String!,$name:String!){",
  "repository(owner:$owner,name:$name){",
  "milestones(first:30,states:[OPEN,CLOSED]){nodes{number title state openIssues:issues(states:[OPEN]){totalCount} closedIssues:issues(states:[CLOSED]){totalCount}}}",
  "openIssues:issues(first:100,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title state url updatedAt labels(first:10){nodes{name}} milestone{number title}}}",
  "closedIssues:issues(first:100,states:[CLOSED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title state url updatedAt labels(first:10){nodes{name}} milestone{number title}}}",
  "openPulls:pullRequests(first:30,states:[OPEN],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title isDraft url updatedAt headRefName headRefOid reviewDecision mergeStateStatus autoMergeRequest{enabledAt} mergeQueueEntry{position state} milestone{number title} closingIssuesReferences(first:10){nodes{number milestone{title}}} commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:50){nodes{__typename ... on CheckRun{name status conclusion} ... on StatusContext{context state}}}}}}}}}",
  "mergedPulls:pullRequests(first:12,states:[MERGED],orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number title url mergedAt headRefName milestone{number title} closingIssuesReferences(first:5){nodes{number milestone{title}}}}}",
  "}}",
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

function extractReferencedIssueNumbers(title, closingRefs) {
  const seen = new Set();
  if (Array.isArray(closingRefs)) {
    for (const ref of closingRefs) {
      if (Number.isSafeInteger(ref?.number) && ref.number > 0) {
        seen.add(ref.number);
      }
    }
  }
  if (typeof title === "string") {
    for (const match of title.matchAll(ISSUE_REF_PATTERN)) {
      const parsed = Number.parseInt(match[1], 10);
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
  if (pull.milestoneTitle && !isHistoricalMilestoneTitle(pull.milestoneTitle)) {
    const fromMilestone = extractMilestoneStep(pull.milestoneTitle).milestoneId;
    if (fromMilestone) {
      return fromMilestone;
    }
  }
  const fromTitle = extractMilestoneStep(pull.title).milestoneId;
  if (fromTitle) {
    return fromTitle;
  }
  for (const issueNumber of pull.linkedIssueNumbers) {
    const mapped = issueMilestoneMap.get(issueNumber);
    if (mapped) {
      return mapped;
    }
  }
  return null;
}

export function normalizeCheckRollup(rollup) {
  if (!rollup || typeof rollup !== "object") {
    return { state: "UNKNOWN", total: 0, passed: 0, failed: 0, pending: 0 };
  }
  const contexts = Array.isArray(rollup.contexts) ? rollup.contexts : null;
  if (!contexts || contexts.length === 0) {
    const rawState = typeof rollup.state === "string" ? rollup.state.toUpperCase() : "";
    if (rawState === "SUCCESS") {
      return { state: "PASS", total: 0, passed: 0, failed: 0, pending: 0 };
    }
    if (rawState === "FAILURE" || rawState === "ERROR") {
      return { state: "FAIL", total: 0, passed: 0, failed: 0, pending: 0 };
    }
    if (rawState === "PENDING" || rawState === "EXPECTED") {
      return { state: "PENDING", total: 0, passed: 0, failed: 0, pending: 0 };
    }
    return { state: "UNKNOWN", total: 0, passed: 0, failed: 0, pending: 0 };
  }

  let passed = 0;
  let failed = 0;
  let pending = 0;
  for (const item of contexts) {
    if (!item || typeof item !== "object") {
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
    }
  }

  const total = passed + failed + pending;
  if (total === 0) {
    return { state: "UNKNOWN", total: 0, passed: 0, failed: 0, pending: 0 };
  }
  const state = failed > 0 ? "FAIL" : pending > 0 ? "PENDING" : "PASS";
  return { state, total, passed, failed, pending };
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
  return hasApproved ? "APPROVED" : "PENDING";
}

export function normalizeMergeQueue(entry) {
  if (!entry || typeof entry !== "object") {
    return { queued: false, state: null, position: null };
  }
  return {
    queued: true,
    state: typeof entry.state === "string" && entry.state.length > 0 ? entry.state : "QUEUED",
    position: Number.isSafeInteger(entry.position) && entry.position >= 0 ? entry.position : null,
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
  for (const item of rawIssues) {
    if (!Number.isSafeInteger(item?.number) || item.number < 1 || typeof item.title !== "string") {
      continue;
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
  for (const pr of rawOpenPulls) {
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || typeof pr.title !== "string") {
      continue;
    }
    const linkedIssueNumbers = extractReferencedIssueNumbers(pr.title, pr.closingIssuesReferences);
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
  for (const pr of rawMergedPulls) {
    if (!Number.isSafeInteger(pr?.number) || pr.number < 1 || typeof pr.title !== "string") {
      continue;
    }
    const linkedIssueNumbers = extractReferencedIssueNumbers(pr.title, pr.closingIssuesReferences);
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

  const allIssues = [...issueByNumber.values()].sort((a, b) => a.number - b.number);
  const unassignedIssues = allIssues.filter((issue) => issue.milestoneId === null);

  const milestones = CANONICAL_MILESTONES.map(({ id, defaultTitle }) => {
    const native = nativeMilestones.get(id);
    const issues = allIssues.filter((issue) => issue.milestoneId === id);
    const openCount = issues.filter((issue) => issue.state === "OPEN").length;
    const closedCount = issues.filter((issue) => issue.state === "CLOSED").length;
    const totalIssues = openCount + closedCount;
    const completionPercent = totalIssues > 0 ? Math.round((closedCount / totalIssues) * 100) : 0;
    const milestonePulls = openPulls.filter((pr) => pr.milestoneId === id);

    return {
      id,
      number: native ? native.number : null,
      title: native ? native.title : defaultTitle,
      state: native ? native.state : "open",
      openIssues: openCount,
      closedIssues: closedCount,
      totalIssues,
      completionPercent,
      activePulls: milestonePulls.length,
      ciPassingPulls: milestonePulls.filter((pr) => pr.ci.state === "PASS").length,
      ciPendingPulls: milestonePulls.filter((pr) => pr.ci.state === "PENDING").length,
      ciFailingPulls: milestonePulls.filter((pr) => pr.ci.state === "FAIL").length,
      queuedPulls: milestonePulls.filter((pr) => pr.mergeQueue.queued).length,
      issues: issues.map(({ milestoneTitle: _mt, ...rest }) => rest),
    };
  });

  const issuesOpen = allIssues.filter((i) => i.state === "OPEN").length;
  const issuesClosed = allIssues.filter((i) => i.state === "CLOSED").length;
  const issuesTotal = issuesOpen + issuesClosed;

  return {
    repo,
    source,
    readOnly: true,
    ok: true,
    stale: false,
    error: null,
    generatedAt,
    totals: {
      milestonesOpen: milestones.filter((m) => m.state === "open").length,
      issuesOpen,
      issuesClosed,
      issuesTotal,
      completionPercent: issuesTotal > 0 ? Math.round((issuesClosed / issuesTotal) * 100) : 0,
      openPulls: openPulls.length,
      draftPulls: openPulls.filter((pr) => pr.isDraft).length,
      ciPassingPulls: openPulls.filter((pr) => pr.ci.state === "PASS").length,
      ciPendingPulls: openPulls.filter((pr) => pr.ci.state === "PENDING").length,
      ciFailingPulls: openPulls.filter((pr) => pr.ci.state === "FAIL").length,
      ciUnknownPulls: openPulls.filter((pr) => pr.ci.state === "UNKNOWN").length,
      approvedPulls: openPulls.filter((pr) => pr.reviewStatus === "APPROVED").length,
      queuedPulls: openPulls.filter((pr) => pr.mergeQueue.queued).length,
      mergedRecentPulls: mergedPulls.length,
    },
    milestones,
    openPulls: openPulls.map(({ milestoneTitle: _mt, ...rest }) => rest),
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
  if (previousSnapshot && previousSnapshot.repo === repo) {
    return {
      ...previousSnapshot,
      ok: false,
      stale: true,
      error: normalizedError,
      lastAttemptAt: generatedAt,
    };
  }
  const empty = buildFactoryBoardSnapshot(
    { milestones: [], issues: [], openPulls: [], mergedPulls: [] },
    { repo, source: "unavailable", generatedAt },
  );
  return {
    ...empty,
    ok: false,
    stale: false,
    error: normalizedError,
  };
}

export function summarizeSnapshot(snapshot, { intervalSeconds, paused }) {
  return {
    repo: snapshot.repo,
    source: snapshot.source,
    readOnly: true,
    ok: snapshot.ok,
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
        env: { ...process.env, GH_PAGER: "", GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
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

export async function fetchViaGhGraphql({
  owner,
  name,
  execGh = defaultExecGh,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const stdout = await execGh(
    [
      "api",
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

  const issueMap = new Map();
  for (const bucket of [repoNode.openIssues?.nodes, repoNode.closedIssues?.nodes]) {
    if (!Array.isArray(bucket)) {
      continue;
    }
    for (const node of bucket) {
      if (node && Number.isSafeInteger(node.number)) {
        issueMap.set(node.number, {
          number: node.number,
          title: node.title,
          state: node.state,
          url: node.url,
          updatedAt: node.updatedAt,
          labels: Array.isArray(node.labels?.nodes)
            ? node.labels.nodes.map((l) => l?.name).filter((n) => typeof n === "string")
            : [],
          milestoneTitle: node.milestone?.title ?? null,
        });
      }
    }
  }

  const openPullNodes = Array.isArray(repoNode.openPulls?.nodes) ? repoNode.openPulls.nodes : [];
  const openPulls = openPullNodes.map((node) => {
    const commitRollup = node?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const checkRollup = commitRollup
      ? {
          state: commitRollup.state,
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
      mergeQueueEntry: node?.mergeQueueEntry ?? null,
      milestoneTitle: node?.milestone?.title ?? null,
      closingIssuesReferences: node?.closingIssuesReferences?.nodes ?? [],
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
    closingIssuesReferences: node?.closingIssuesReferences?.nodes ?? [],
  }));

  const milestoneNodes = Array.isArray(repoNode.milestones?.nodes) ? repoNode.milestones.nodes : [];
  const milestones = milestoneNodes.map((node) => ({
    number: node?.number,
    title: node?.title,
    state: node?.state,
  }));

  return { milestones, issues: [...issueMap.values()], openPulls, mergedPulls };
}

export async function fetchViaPublicRest({
  owner,
  name,
  request = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxDetailPulls = 6,
}) {
  const baseUrl = `https://api.github.com/repos/${owner}/${name}`;
  const getJson = async (path) => {
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
    return readBoundedJson(response, maxBytes);
  };

  const [milestonesJson, issuesJson, openPullsJson, closedPullsJson] = await Promise.all([
    getJson("/milestones?state=all&per_page=30"),
    getJson("/issues?state=all&per_page=100"),
    getJson("/pulls?state=open&sort=updated&direction=desc&per_page=25"),
    getJson("/pulls?state=closed&sort=updated&direction=desc&per_page=20"),
  ]);

  if (
    !Array.isArray(milestonesJson) ||
    !Array.isArray(issuesJson) ||
    !Array.isArray(openPullsJson) ||
    !Array.isArray(closedPullsJson)
  ) {
    throw new Error("REST_PAYLOAD_INVALID");
  }

  const milestones = milestonesJson.map((m) => ({
    number: m?.number,
    title: m?.title,
    state: m?.state,
  }));

  const issues = issuesJson
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
      milestoneTitle: item.milestone?.title ?? null,
    }));

  const openPulls = await Promise.all(
    openPullsJson.map(async (pr, index) => {
      const headSha = pr?.head?.sha;
      let checkRollup = null;
      let reviews = undefined;
      if (index < maxDetailPulls && typeof headSha === "string" && headSha.length > 0 && Number.isSafeInteger(pr?.number)) {
        const [checksResult, reviewsResult] = await Promise.allSettled([
          getJson(`/commits/${headSha}/check-runs?per_page=50`),
          getJson(`/pulls/${pr.number}/reviews?per_page=30`),
        ]);
        if (checksResult.status === "fulfilled" && Array.isArray(checksResult.value?.check_runs)) {
          checkRollup = { contexts: checksResult.value.check_runs };
        }
        if (reviewsResult.status === "fulfilled" && Array.isArray(reviewsResult.value)) {
          reviews = reviewsResult.value;
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
        mergeQueueEntry: null,
        milestoneTitle: pr?.milestone?.title ?? null,
        closingIssuesReferences: [],
        checkRollup,
      };
    }),
  );

  const mergedPulls = closedPullsJson
    .filter((pr) => pr && typeof pr.merged_at === "string" && pr.merged_at.length > 0)
    .slice(0, 12)
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      mergedAt: pr.merged_at,
      headRefName: pr.head?.ref,
      milestoneTitle: pr.milestone?.title ?? null,
      closingIssuesReferences: [],
    }));

  return { milestones, issues, openPulls, mergedPulls };
}

export async function fetchFactoryBoardSnapshot({
  repo = DEFAULT_REPO,
  execGh = defaultExecGh,
  request = fetch,
  clock = () => new Date().toISOString(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  previousSnapshot = null,
} = {}) {
  const generatedAt = clock();
  let parsedRepo;
  try {
    parsedRepo = parseRepoSlug(repo);
  } catch {
    return buildUnavailableSnapshot({
      repo: String(repo),
      generatedAt,
      error: { code: "INVALID_REPO_SLUG", message: "Repository must use owner/name format." },
      previousSnapshot: null,
    });
  }

  try {
    const raw = await fetchViaGhGraphql({
      owner: parsedRepo.owner,
      name: parsedRepo.name,
      execGh,
      timeoutMs,
    });
    return buildFactoryBoardSnapshot(raw, {
      repo: parsedRepo.fullName,
      source: "gh-graphql",
      generatedAt,
    });
  } catch {
    try {
      const raw = await fetchViaPublicRest({
        owner: parsedRepo.owner,
        name: parsedRepo.name,
        request,
        timeoutMs,
        maxBytes,
      });
      return buildFactoryBoardSnapshot(raw, {
        repo: parsedRepo.fullName,
        source: "github-rest",
        generatedAt,
      });
    } catch (restErr) {
      return buildUnavailableSnapshot({
        repo: parsedRepo.fullName,
        generatedAt,
        error: {
          code: "SNAPSHOT_FETCH_FAILED",
          message:
            restErr instanceof Error && restErr.message
              ? restErr.message
              : "Both gh CLI and public GitHub REST reads failed.",
        },
        previousSnapshot,
      });
    }
  }
}

export function formatBoardStatus(intervalSeconds, paused) {
  return paused ? "Paused" : `Auto-refreshing (${intervalSeconds}s)`;
}

export function createBoardPoller({
  repo = DEFAULT_REPO,
  intervalSeconds: initialInterval = DEFAULT_INTERVAL_SECONDS,
  fetchSnapshot = fetchFactoryBoardSnapshot,
  timers = { setInterval, clearInterval },
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
  let inflight = null;
  let timerHandle = null;
  const listeners = new Set();

  const buildEnvelope = () => ({
    snapshot,
    config: {
      repo: parsed.fullName,
      intervalSeconds: currentInterval,
      paused,
      status: formatBoardStatus(currentInterval, paused),
    },
  });

  const notify = () => {
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
        });
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
