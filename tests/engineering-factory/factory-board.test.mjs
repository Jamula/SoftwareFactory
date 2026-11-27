import test from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CANONICAL_MILESTONES,
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_REPO,
  buildFactoryBoardSnapshot,
  buildUnavailableSnapshot,
  combineRestChecksAndStatus,
  createBoardPoller,
  createSseClientRegistry,
  extractMilestoneStep,
  extractReferencedIssueNumbers,
  fetchFactoryBoardSnapshot,
  fetchViaGhGraphql,
  fetchViaPublicRest,
  formatBoardStatus,
  inferIssueMilestoneId,
  inferPullMilestoneId,
  initFactoryBoardClient,
  normalizeCheckRollup,
  normalizeMergeQueue,
  normalizeReviewStatus,
  parseRateLimitHeaders,
  parseRepoSlug,
  readBoundedJson,
  summarizeSnapshot,
  validateIntervalSeconds,
} from "../../tools/engineering-factory/factory-board.mjs";
import {
  CANVAS_DESCRIPTION,
  CANVAS_DISPLAY_NAME,
  CANVAS_ID,
  createBoardInstanceManager,
  createFactoryBoardCanvasSpec,
  renderBoardHtml,
  startFactoryBoardExtension,
  startLoopbackBoardServer,
} from "../../.github/extensions/factory-board/board-ui.mjs";

const execFileAsync = promisify(execFileCb);

class MockCanvasError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CanvasError";
    this.code = code;
  }
}

test("parseRepoSlug and validateIntervalSeconds enforce strict boundaries", () => {
  assert.deepEqual(parseRepoSlug("Jamula/SoftwareFactory"), {
    owner: "Jamula",
    name: "SoftwareFactory",
    fullName: "Jamula/SoftwareFactory",
  });
  assert.deepEqual(parseRepoSlug("  octo_org.1/my-repo.2  "), {
    owner: "octo_org.1",
    name: "my-repo.2",
    fullName: "octo_org.1/my-repo.2",
  });

  for (const invalid of [null, undefined, 42, "", "noslash", "a/b/c", "bad space/repo", "/repo", "owner/"]) {
    assert.throws(() => parseRepoSlug(invalid), /INVALID_REPO_SLUG/);
  }

  assert.deepEqual(validateIntervalSeconds(10), { valid: true, intervalSeconds: 10 });
  assert.deepEqual(validateIntervalSeconds(20), { valid: true, intervalSeconds: 20 });
  assert.deepEqual(validateIntervalSeconds(300), { valid: true, intervalSeconds: 300 });

  for (const bad of [9, 301, 0, -5, 15.5, Number.NaN, "20", null, undefined]) {
    const res = validateIntervalSeconds(bad);
    assert.equal(res.valid, false);
    assert.equal(res.reason, "INVALID_INTERVAL");
    assert.match(res.message, /between 10 and 300/);
  }

  assert.equal(formatBoardStatus(20, false), "Auto-refreshing (20s)");
  assert.equal(formatBoardStatus(45, true), "Paused");
});

test("extractMilestoneStep and milestone inference handle active, historical, label, title, and issue-linked cases", () => {
  assert.deepEqual(extractMilestoneStep(""), { milestoneId: null, stepId: null });
  assert.deepEqual(extractMilestoneStep(null), { milestoneId: null, stepId: null });
  assert.deepEqual(extractMilestoneStep("Unrelated chore"), { milestoneId: null, stepId: null });
  assert.deepEqual(extractMilestoneStep("[M01.07.01 P0] Cloud check"), {
    milestoneId: "M01",
    stepId: "M01.07.01",
  });
  assert.deepEqual(extractMilestoneStep("feat(m02.03): specialist routing"), {
    milestoneId: "M02",
    stepId: "M02.03",
  });
  assert.deepEqual(extractMilestoneStep("M05 - FamilyHub autonomous adoption"), {
    milestoneId: "M05",
    stepId: null,
  });

  assert.equal(
    inferIssueMilestoneId({
      milestoneTitle: "M03 - FamilyTree autonomous adoption",
      labels: ["M01"],
      title: "[M02.01] Something",
    }),
    "M03",
  );
  assert.equal(
    inferIssueMilestoneId({
      milestoneTitle: "Historical v1 M03 (consolidated into M01 #2)",
      labels: ["enhancement", "M01"],
      title: "Unlabeled title",
    }),
    "M01",
  );
  assert.equal(
    inferIssueMilestoneId({
      milestoneTitle: "Custom non-roadmap milestone",
      labels: ["enhancement"],
      title: "[M04.01 P1] Apply SoftwareFactory to Spellbook",
    }),
    "M04",
  );

  const issueMap = new Map([
    [18, "M02"],
    [105, "M01"],
  ]);
  assert.equal(
    inferPullMilestoneId(
      { milestoneTitle: "M05 - FamilyHub", title: "chore: update", linkedIssueNumbers: [18] },
      issueMap,
    ),
    "M05",
  );
  assert.equal(
    inferPullMilestoneId(
      {
        milestoneTitle: "Historical v1 M04 (consolidated)",
        title: "chore: scorecard (#18)",
        linkedIssueNumbers: [999, 18],
      },
      issueMap,
    ),
    "M02",
  );
  // Historical milestone skips legacy v1 title code ("M02.05") and returns null when unlinked
  assert.equal(
    inferPullMilestoneId(
      {
        milestoneTitle: "Historical v1 M02",
        title: "M02.05: Prevent duplicate claims",
        linkedIssueNumbers: [],
      },
      issueMap,
    ),
    null,
  );
  assert.equal(
    inferPullMilestoneId(
      {
        milestoneTitle: "Unmapped milestone",
        title: "chore: cleanup (#999)",
        linkedIssueNumbers: [999],
      },
      issueMap,
    ),
    null,
  );
});

test("normalizeCheckRollup, combineRestChecksAndStatus, normalizeReviewStatus, and normalizeMergeQueue fail closed on missing, truncated, or mixed states", () => {
  assert.deepEqual(normalizeCheckRollup(null), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "SUCCESS", contexts: [] }), {
    state: "PASS",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "FAILURE" }), {
    state: "FAIL",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "ERROR" }), {
    state: "FAIL",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "PENDING" }), {
    state: "PENDING",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "EXPECTED" }), {
    state: "PENDING",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "UNRECOGNIZED" }), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({}), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });
  assert.deepEqual(normalizeCheckRollup({ contexts: [null, { unknownField: 1 }] }), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
    truncated: false,
  });

  assert.deepEqual(
    normalizeCheckRollup({
      contexts: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "NEUTRAL" },
        { status: "COMPLETED", conclusion: "SKIPPED" },
        { state: "SUCCESS" },
      ],
    }),
    { state: "PASS", total: 4, passed: 4, failed: 0, pending: 0, truncated: false },
  );

  // Aggregate FAILURE / PENDING overrides passing bounded context slice
  assert.deepEqual(
    normalizeCheckRollup({
      state: "FAILURE",
      totalCount: 60,
      truncated: true,
      contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    { state: "FAIL", total: 60, passed: 1, failed: 0, pending: 0, truncated: true },
  );
  assert.deepEqual(
    normalizeCheckRollup({
      state: "PENDING",
      totalCount: 60,
      contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    { state: "PENDING", total: 60, passed: 1, failed: 0, pending: 0, truncated: true },
  );
  // Truncated or unrecognized contexts without authoritative aggregate state fail closed to UNKNOWN
  assert.deepEqual(
    normalizeCheckRollup({
      state: null,
      totalCount: 120,
      contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    { state: "UNKNOWN", total: 120, passed: 1, failed: 0, pending: 0, truncated: true },
  );
  assert.deepEqual(
    normalizeCheckRollup({
      state: null,
      totalCount: 2,
      contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }, null],
    }),
    { state: "UNKNOWN", total: 2, passed: 1, failed: 0, pending: 0, truncated: false },
  );
  assert.deepEqual(
    normalizeCheckRollup({
      state: null,
      contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }, { unrecognizedShape: true }],
    }),
    { state: "UNKNOWN", total: 1, passed: 1, failed: 0, pending: 0, truncated: false },
  );
  // Truncated contexts with authoritative aggregate SUCCESS preserve PASS
  assert.deepEqual(
    normalizeCheckRollup({
      state: "SUCCESS",
      totalCount: 120,
      truncated: true,
      contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    { state: "PASS", total: 120, passed: 1, failed: 0, pending: 0, truncated: true },
  );

  assert.deepEqual(
    normalizeCheckRollup({
      contexts: [
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: "" },
        { state: "PENDING" },
        { state: "EXPECTED" },
      ],
    }),
    { state: "PENDING", total: 4, passed: 1, failed: 0, pending: 3, truncated: false },
  );

  assert.deepEqual(
    normalizeCheckRollup({
      contexts: [
        { status: "IN_PROGRESS", conclusion: "" },
        { status: "COMPLETED", conclusion: "FAILURE" },
        { status: "COMPLETED" },
        { state: "FAILURE" },
      ],
    }),
    { state: "FAIL", total: 4, passed: 0, failed: 3, pending: 1, truncated: false },
  );

  // combineRestChecksAndStatus: requires both endpoints complete unless failure is established
  assert.equal(combineRestChecksAndStatus(null, null), null);
  const completeRest = combineRestChecksAndStatus(
    { total_count: 1, check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
    { state: "pending", total_count: 0, statuses: [] },
  );
  assert.equal(normalizeCheckRollup(completeRest).state, "PASS");

  const failingLegacyStatus = combineRestChecksAndStatus(
    { total_count: 1, check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
    { state: "failure", total_count: 1, statuses: [{ context: "ci/ext", state: "failure" }] },
  );
  assert.equal(normalizeCheckRollup(failingLegacyStatus).state, "FAIL");

  const pendingLegacyStatus = combineRestChecksAndStatus(
    { total_count: 1, check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
    { state: "pending", total_count: 2, statuses: [{ context: "ci/ext", state: "success" }, { context: "ci/2", state: "success" }] },
  );
  assert.equal(normalizeCheckRollup(pendingLegacyStatus).state, "PENDING");

  const missingStatusEndpoint = combineRestChecksAndStatus(
    { total_count: 1, check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
    null,
  );
  assert.equal(normalizeCheckRollup(missingStatusEndpoint).state, "UNKNOWN");

  const truncatedChecksWithFailure = combineRestChecksAndStatus(
    { total_count: 150, check_runs: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
    null,
  );
  assert.equal(normalizeCheckRollup(truncatedChecksWithFailure).state, "FAIL");

  const truncatedStatusesWithAggregateError = combineRestChecksAndStatus(
    null,
    { state: "error", total_count: 150, statuses: [{ context: "ci/ok", state: "success" }] },
  );
  assert.equal(normalizeCheckRollup(truncatedStatusesWithAggregateError).state, "FAIL");

  assert.equal(normalizeReviewStatus("APPROVED"), "APPROVED");
  assert.equal(normalizeReviewStatus("changes_requested"), "CHANGES_REQUESTED");
  assert.equal(normalizeReviewStatus("REVIEW_REQUIRED"), "REVIEW_REQUIRED");
  assert.equal(normalizeReviewStatus(""), "PENDING");
  assert.equal(normalizeReviewStatus(null), "PENDING");
  assert.equal(normalizeReviewStatus("UNRECOGNIZED", undefined), "UNKNOWN");
  assert.equal(normalizeReviewStatus(undefined, undefined), "UNKNOWN");
  assert.equal(
    normalizeReviewStatus(undefined, [
      null,
      { user: { login: "alice" }, state: "COMMENTED" },
      { user: { login: "bob" }, state: "APPROVED" },
      { user: { login: "bob" }, state: "DISMISSED" },
    ]),
    "PENDING",
  );
  assert.equal(
    normalizeReviewStatus(undefined, [
      { user: { login: "alice" }, state: "APPROVED" },
      { user: { login: "carol" }, state: "CHANGES_REQUESTED" },
    ]),
    "CHANGES_REQUESTED",
  );
  assert.equal(
    normalizeReviewStatus(undefined, [{ user: { login: "alice" }, state: "APPROVED" }]),
    "HAS_APPROVAL",
  );

  assert.deepEqual(normalizeMergeQueue(undefined), {
    known: false,
    queued: null,
    state: "UNKNOWN",
    position: null,
  });
  assert.deepEqual(normalizeMergeQueue("invalid"), {
    known: false,
    queued: null,
    state: "UNKNOWN",
    position: null,
  });
  assert.deepEqual(normalizeMergeQueue(null), {
    known: true,
    queued: false,
    state: null,
    position: null,
  });
  assert.deepEqual(normalizeMergeQueue({ state: "AWAITING_CHECKS", position: 1 }), {
    known: true,
    queued: true,
    state: "AWAITING_CHECKS",
    position: 1,
  });
  assert.deepEqual(normalizeMergeQueue({ state: "", position: 0 }), {
    known: true,
    queued: true,
    state: "QUEUED",
    position: null,
  });

  // Cross-repo vs local issue reference extraction
  assert.deepEqual(
    extractReferencedIssueNumbers(
      "Pilot Jamula/FamilyTree#18 and Jamula/FamilyTree #19 and https://github.com/octo/x/issues/1#20; local (#5) and Jamula/SoftwareFactory#18",
      [
        { number: 4, repo: "Jamula/SoftwareFactory" },
        { number: 99, repo: "Jamula/FamilyTree" },
        { number: 77, repo: null },
        { number: 0, repo: "Jamula/SoftwareFactory" },
      ],
      "Jamula/SoftwareFactory",
    ),
    [4, 5, 18],
  );
});

test("buildFactoryBoardSnapshot, summarizeSnapshot, and buildUnavailableSnapshot aggregate milestones and PRs accurately", () => {
  const raw = {
    milestones: [
      null,
      { number: 1, title: "M01 - Reusable factory foundation", state: "CLOSED" },
      { number: 2, title: "M01 - Autonomous SoftwareFactory", state: "OPEN" },
      { number: 3, title: "Historical v1 M03 (consolidated into M01 #2)", state: "CLOSED" },
      { number: "bad", title: "M02 - Fast SoftwareFactory", state: "OPEN" },
      { number: 99, title: "Unmapped milestone", state: "OPEN" },
    ],
    issues: [
      { number: 0, title: "Invalid zero" },
      {
        number: 1,
        title: "[M01.01 P0] Shared factory foundation",
        state: "CLOSED",
        labels: [null, "M01"],
        milestoneTitle: "M01 - Reusable factory foundation",
      },
      {
        number: 5,
        title: "[M01.03] GitHub event orchestration",
        state: "OPEN",
        url: "https://github.com/Jamula/SoftwareFactory/issues/5",
        updatedAt: "2026-11-27T00:00:00Z",
        labels: ["P0", "M01"],
        milestoneTitle: "M01 - Autonomous SoftwareFactory",
      },
      {
        number: 18,
        title: "[M02.02 P1] Engineering speed scorecard",
        state: "OPEN",
        labels: "not-an-array",
        milestoneTitle: "M02 - Fast SoftwareFactory",
      },
      {
        number: 76,
        title: "Unassigned consumer idea",
        state: "CLOSED",
        labels: [],
        milestoneTitle: null,
      },
    ],
    openPulls: [
      { number: -1, title: "Invalid PR" },
      {
        number: 132,
        title: "[M01.03] Shadow event orchestration (#5)",
        isDraft: false,
        url: "https://github.com/Jamula/SoftwareFactory/pull/132",
        updatedAt: "2026-11-27T00:10:00Z",
        headRefName: "u/dev/event-orch",
        headSha: "a".repeat(40),
        reviewDecision: "APPROVED",
        mergeStateStatus: "clean",
        autoMerge: true,
        mergeQueueEntry: { state: "QUEUED", position: 1 },
        closingIssuesReferences: [
          { number: 5, repo: "Jamula/SoftwareFactory" },
          { number: 18, repo: "Jamula/FamilyTree" },
          { number: 0, repo: "Jamula/SoftwareFactory" },
        ],
        checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
      },
      {
        number: 128,
        title: "Add scorecard (#18) after Jamula/Spellbook#1",
        isDraft: true,
        reviewDecision: "",
        mergeStateStatus: "",
        autoMerge: false,
        mergeQueueEntry: null,
        closingIssuesReferences: null,
        checkRollup: { contexts: [{ status: "IN_PROGRESS", conclusion: "" }] },
      },
      {
        number: 140,
        title: "Failing experimental branch",
        isDraft: false,
        milestoneTitle: "M01 - Autonomous SoftwareFactory",
        reviewDecision: undefined,
        reviews: undefined,
        mergeQueueEntry: null,
        checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
      },
      {
        number: 141,
        title: "Unchecked chore PR",
        isDraft: false,
        mergeQueueEntry: null,
        checkRollup: null,
      },
    ],
    mergedPulls: [
      { number: 0, title: "Invalid" },
      {
        number: 125,
        title: "M02.04: Add throughput checkpoint (#18)",
        mergedAt: "2026-11-26T23:00:00Z",
        headRefName: "u/dev/m02",
        closingIssuesReferences: [{ number: 18, repo: "Jamula/SoftwareFactory" }],
      },
      {
        number: 121,
        title: "Misc docs tweak",
        url: "https://github.com/Jamula/SoftwareFactory/pull/121",
      },
    ],
  };

  const snap = buildFactoryBoardSnapshot(raw, {
    repo: DEFAULT_REPO,
    source: "gh-graphql",
    generatedAt: "2026-11-27T01:00:00Z",
  });

  assert.equal(snap.ok, true);
  assert.equal(snap.readOnly, true);
  assert.equal(snap.milestones.length, CANONICAL_MILESTONES.length);

  const m01 = snap.milestones.find((m) => m.id === "M01");
  assert.equal(m01.number, 2);
  assert.equal(m01.title, "M01 - Autonomous SoftwareFactory");
  assert.equal(m01.closedIssues, 1);
  assert.equal(m01.openIssues, 1);
  assert.equal(m01.completionPercent, 50);
  assert.equal(m01.activePulls, 2);
  assert.equal(m01.ciPassingPulls, 1);
  assert.equal(m01.ciFailingPulls, 1);
  assert.equal(m01.queuedPulls, 1);
  const issue5 = m01.issues.find((i) => i.number === 5);
  assert.deepEqual(issue5.linkedPullNumbers, [132]);

  const m02 = snap.milestones.find((m) => m.id === "M02");
  assert.equal(m02.number, null);
  assert.equal(m02.state, "open");
  assert.equal(m02.activePulls, 1);
  assert.equal(m02.ciPendingPulls, 1);
  // Missing placeholder milestones (M03–M05) report state "missing" and do not count as open
  const m03 = snap.milestones.find((m) => m.id === "M03");
  assert.equal(m03.state, "missing");
  assert.equal(snap.totals.milestonesOpen, 2);

  assert.equal(snap.unassignedIssues.length, 1);
  assert.equal(snap.unassignedIssues[0].number, 76);
  assert.equal(snap.totals.openPulls, 4);
  assert.equal(snap.totals.draftPulls, 1);
  assert.equal(snap.totals.ciUnknownPulls, 1);
  assert.equal(snap.totals.approvedPulls, 1);
  assert.equal(snap.totals.queuedPulls, 1);
  assert.equal(snap.totals.mergedRecentPulls, 2);

  const summary = summarizeSnapshot(snap, { intervalSeconds: 20, paused: false });
  assert.equal(summary.intervalSeconds, 20);
  assert.equal(summary.paused, false);
  assert.equal(summary.milestones.length, 5);

  const stale = buildUnavailableSnapshot({
    repo: DEFAULT_REPO,
    generatedAt: "2026-11-27T01:05:00Z",
    error: { code: "NET_DOWN", message: "Timed out" },
    previousSnapshot: snap,
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.totals.openPulls, 4);
  assert.equal(stale.lastAttemptAt, "2026-11-27T01:05:00Z");

  const coldUnavailable = buildUnavailableSnapshot({
    repo: DEFAULT_REPO,
    generatedAt: "2026-11-27T01:05:00Z",
    error: {},
    previousSnapshot: null,
  });
  assert.equal(coldUnavailable.ok, false);
  assert.equal(coldUnavailable.verified, false);
  assert.equal(coldUnavailable.stale, false);
  assert.equal(coldUnavailable.source, "unavailable");
  assert.equal(coldUnavailable.totals, null);
  assert.deepEqual(coldUnavailable.milestones, []);
  assert.equal(coldUnavailable.error.code, "SNAPSHOT_UNAVAILABLE");

  // Repeated cold-start failure must NOT convert unverified snapshot into stale verified data
  const secondColdUnavailable = buildUnavailableSnapshot({
    repo: DEFAULT_REPO,
    generatedAt: "2026-11-27T01:05:20Z",
    error: { code: "NET_DOWN", message: "Still offline" },
    previousSnapshot: coldUnavailable,
  });
  assert.equal(secondColdUnavailable.verified, false);
  assert.equal(secondColdUnavailable.stale, false);
  assert.equal(secondColdUnavailable.totals, null);

  // Truncated inventory marks partial: true and completionPercent: null
  const partialSnap = buildFactoryBoardSnapshot(
    { ...raw, truncated: true },
    { repo: DEFAULT_REPO, source: "github-rest", generatedAt: "2026-11-27T01:06:00Z" },
  );
  assert.equal(partialSnap.partial, true);
  assert.equal(partialSnap.totals.completionPercent, null);
  assert.equal(partialSnap.milestones[0].completionPercent, null);

  const emptyInputSnap = buildFactoryBoardSnapshot(null, {
    repo: DEFAULT_REPO,
    source: "github-rest",
    generatedAt: "2026-11-27T01:06:00Z",
  });
  assert.equal(emptyInputSnap.totals.issuesTotal, 0);
});

test("readBoundedJson enforces HTTP status, body presence, byte limits, and valid JSON", async () => {
  await assert.rejects(() => readBoundedJson(null), /HTTP_UNAVAILABLE/);
  await assert.rejects(
    () => readBoundedJson(new Response("err", { status: 503 })),
    /HTTP_UNAVAILABLE/,
  );
  await assert.rejects(() => readBoundedJson(new Response(null)), /HTTP_UNAVAILABLE/);
  await assert.rejects(
    () => readBoundedJson(new Response(JSON.stringify({ big: "x".repeat(200) })), 32),
    /RESPONSE_TOO_LARGE/,
  );
  await assert.rejects(() => readBoundedJson(new Response("{not-json")), SyntaxError);

  const parsed = await readBoundedJson(new Response(JSON.stringify({ hello: "world" })), 1024);
  assert.deepEqual(parsed, { hello: "world" });
});

test("fetchViaGhGraphql, fetchViaPublicRest, and fetchFactoryBoardSnapshot handle primary, fallback, and fail-closed paths", async () => {
  const graphqlPayload = {
    data: {
      repository: {
        milestones: {
          pageInfo: { hasNextPage: false },
          nodes: [{ number: 2, title: "M01 - Autonomous SoftwareFactory", state: "OPEN" }],
        },
        openIssues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            null,
            {
              number: 4,
              title: "[M01.01 P0] Exact-head quality",
              state: "OPEN",
              url: "https://github.com/Jamula/SoftwareFactory/issues/4",
              updatedAt: "2026-11-27T00:00:00Z",
              labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "M01" }, null] },
              milestone: { title: "M01 - Autonomous SoftwareFactory" },
            },
          ],
        },
        closedIssues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              number: 1,
              title: "[M01.01 P0] Foundation",
              state: "CLOSED",
              labels: null,
              milestone: null,
            },
          ],
        },
        openPulls: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              number: 122,
              title: "M01.01: Reconcile coverage (#4)",
              isDraft: false,
              url: "https://github.com/Jamula/SoftwareFactory/pull/122",
              updatedAt: "2026-11-27T00:20:00Z",
              headRefName: "u/dev/cov",
              headRefOid: "b".repeat(40),
              reviewDecision: "APPROVED",
              mergeStateStatus: "BLOCKED",
              autoMergeRequest: { enabledAt: "2026-11-27T00:15:00Z" },
              mergeQueueEntry: null,
              milestone: null,
              closingIssuesReferences: { nodes: [{ number: 4 }] },
              commits: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        state: "SUCCESS",
                        contexts: {
                          nodes: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
                        },
                      },
                    },
                  },
                ],
              },
            },
            {
              number: 123,
              title: "M01.06: Telemetry",
              isDraft: true,
              commits: { nodes: [] },
            },
          ],
        },
        mergedPulls: {
          nodes: [
            {
              number: 119,
              title: "docs: onboarding",
              url: "https://github.com/Jamula/SoftwareFactory/pull/119",
              mergedAt: "2026-11-26T22:00:00Z",
              headRefName: "u/dev/docs",
              milestone: null,
              closingIssuesReferences: null,
            },
          ],
        },
      },
    },
  };

  const observedSummaries = [];
  const captureObserve = async (stage, work) => {
    const summary = await work();
    observedSummaries.push({ stage, ...summary });
  };

  const ghSnap = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:00:00Z",
    observe: captureObserve,
    execGh: async (args) => {
      assert.deepEqual(args.slice(0, 4), ["api", "--hostname", "github.com", "graphql"]);
      return JSON.stringify(graphqlPayload);
    },
    request: async () => {
      throw new Error("should not hit REST when gh succeeds");
    },
  });
  assert.equal(ghSnap.ok, true);
  assert.equal(ghSnap.source, "gh-graphql");
  assert.equal(ghSnap.totals.openPulls, 2);
  assert.deepEqual(observedSummaries.at(-1), {
    stage: "reconcile",
    outcome: "eligible",
    reason: "NONE",
  });

  // Multi-page cursor pagination + truncation detection + pinned --hostname github.com
  let gqlCalls = 0;
  const paginatedGqlRaw = await fetchViaGhGraphql({
    owner: "Jamula",
    name: "SoftwareFactory",
    maxIssuePages: 2,
    execGh: async (args) => {
      gqlCalls += 1;
      assert.deepEqual(args.slice(0, 4), ["api", "--hostname", "github.com", "graphql"]);
      if (args.some((a) => a.startsWith("cursor="))) {
        return JSON.stringify({
          data: {
            repository: {
              issues: {
                pageInfo: { hasNextPage: true, endCursor: "cur-2" },
                nodes: [
                  {
                    number: 99,
                    title: "[M01.08] Page 2 issue",
                    state: "OPEN",
                    labels: { pageInfo: { hasNextPage: true }, nodes: [] },
                  },
                ],
              },
            },
          },
        });
      }
      return JSON.stringify({
        data: {
          repository: {
            milestones: { pageInfo: { hasNextPage: false }, nodes: [] },
            openIssues: {
              pageInfo: { hasNextPage: true, endCursor: "cur-1" },
              nodes: [{ number: 98, title: "[M01.07] Page 1 issue", state: "OPEN" }],
            },
            closedIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
            openPulls: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  number: 1,
                  title: "T",
                  commits: {
                    nodes: [
                      {
                        commit: {
                          statusCheckRollup: { state: "SUCCESS", contexts: null },
                        },
                      },
                    ],
                  },
                },
              ],
            },
            mergedPulls: { nodes: [] },
          },
        },
      });
    },
  });
  assert.equal(gqlCalls, 2);
  assert.equal(paginatedGqlRaw.issues.length, 2);
  assert.equal(paginatedGqlRaw.truncated, true);

  const validInitialRepoWithNext = {
    milestones: { pageInfo: { hasNextPage: false }, nodes: [] },
    openIssues: { pageInfo: { hasNextPage: true, endCursor: "c1" }, nodes: [] },
    closedIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    openPulls: { pageInfo: { hasNextPage: false }, nodes: [] },
    mergedPulls: { nodes: [] },
  };

  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async (args) =>
          args.some((a) => a.startsWith("cursor="))
            ? JSON.stringify({ errors: [{ message: "page error" }] })
            : JSON.stringify({ data: { repository: validInitialRepoWithNext } }),
      }),
    /GH_GRAPHQL_ERRORS/,
  );

  // Reject missing or malformed GraphQL inventory connections & continuation pages
  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async () => JSON.stringify({ data: { repository: { milestones: { nodes: [] } } } }),
      }),
    /GH_GRAPHQL_CONNECTION_INVALID/,
  );
  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async () =>
          JSON.stringify({
            data: {
              repository: {
                ...validInitialRepoWithNext,
                openIssues: { pageInfo: { hasNextPage: true, endCursor: "" }, nodes: [] },
              },
            },
          }),
      }),
    /GH_GRAPHQL_CONNECTION_INVALID/,
  );
  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async () => JSON.stringify({ data: { repository: { milestones: null } } }),
      }),
    /GH_GRAPHQL_CONNECTION_INVALID/,
  );
  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async (args) =>
          args.some((a) => a.startsWith("cursor="))
            ? JSON.stringify({ data: { repository: {} } })
            : JSON.stringify({ data: { repository: validInitialRepoWithNext } }),
      }),
    /GH_GRAPHQL_CONNECTION_INVALID/,
  );

  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async () => JSON.stringify({ errors: [{ message: "denied" }] }),
      }),
    /GH_GRAPHQL_ERRORS/,
  );
  await assert.rejects(
    () =>
      fetchViaGhGraphql({
        owner: "Jamula",
        name: "SoftwareFactory",
        execGh: async () => JSON.stringify({ data: {} }),
      }),
    /GH_REPOSITORY_MISSING/,
  );

  // Fallback to public REST when gh fails, including multi-page /issues and /reviews pagination
  const restRequest = async (url) => {
    const parsedUrl = new URL(url);
    const page = Number(parsedUrl.searchParams.get("page") ?? "1");
    if (url.includes("/milestones?")) {
      return new Response(
        JSON.stringify([{ number: 6, title: "M02 - Fast SoftwareFactory", state: "open" }]),
      );
    }
    if (url.includes("/issues?")) {
      if (page === 1) {
        return new Response(
          JSON.stringify([
            {
              number: 128,
              title: "PR disguised on page 1 of /issues",
              state: "open",
              pull_request: { url: "https://api.github.com/..." },
            },
          ]),
          { headers: { link: '<https://api.github.com/next>; rel="next"' } },
        );
      }
      return new Response(
        JSON.stringify([
          {
            number: 18,
            title: "[M02.02 P1] Scorecard",
            state: "open",
            html_url: "https://github.com/Jamula/SoftwareFactory/issues/18",
            updated_at: "2026-11-27T00:00:00Z",
            labels: [{ name: "M02" }, {}],
            milestone: { title: "M02 - Fast SoftwareFactory" },
          },
          {
            number: 19,
            title: "Unlabeled issue on page 2",
            state: "open",
            labels: null,
            milestone: null,
          },
        ]),
        { headers: { link: '<https://api.github.com/prev>; rel="prev"' } },
      );
    }
    if (url.includes("/pulls?state=open")) {
      return new Response(
        JSON.stringify([
          {
            number: 128,
            title: "M02.02: Scorecard (#18)",
            draft: false,
            html_url: "https://github.com/Jamula/SoftwareFactory/pull/128",
            updated_at: "2026-11-27T00:05:00Z",
            head: { ref: "u/dev/score", sha: "c".repeat(40) },
            mergeable_state: "clean",
            auto_merge: null,
            milestone: null,
          },
          {
            number: 129,
            title: "M01.02: OTel",
            draft: false,
            head: { ref: "u/dev/otel", sha: "d".repeat(40) },
            mergeable_state: "blocked",
          },
          {
            number: 130,
            title: "Beyond detail cap",
            draft: true,
            head: { ref: "u/dev/cap", sha: "" },
          },
        ]),
      );
    }
    if (url.includes("/pulls?state=closed")) {
      return new Response(
        JSON.stringify([
          {
            number: 125,
            title: "M02.04: Benchmark",
            html_url: "https://github.com/Jamula/SoftwareFactory/pull/125",
            merged_at: "2026-11-26T20:00:00Z",
            head: { ref: "u/dev/bench" },
            milestone: { title: "M02 - Fast SoftwareFactory" },
          },
          {
            number: 110,
            title: "Closed unmerged",
            merged_at: null,
          },
        ]),
      );
    }
    if (url.includes(`/commits/${"c".repeat(40)}/check-runs`)) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      );
    }
    if (url.includes(`/commits/${"c".repeat(40)}/status`)) {
      return new Response(
        JSON.stringify({
          state: "pending",
          total_count: 0,
          statuses: [],
        }),
      );
    }
    if (url.includes("/pulls/128/reviews")) {
      if (page === 1) {
        return new Response(
          JSON.stringify([{ user: { login: "rev1" }, state: "APPROVED" }]),
          { headers: { link: '<https://api.github.com/r2>; rel="next"' } },
        );
      }
      return new Response(
        JSON.stringify([{ user: { login: "rev1" }, state: "CHANGES_REQUESTED" }]),
      );
    }
    // Simulate check/review rate limit on second PR -> fail-closed UNKNOWN
    return new Response("rate limited", { status: 403 });
  };

  const restRaw = await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    request: restRequest,
    maxDetailPulls: 2,
  });
  assert.equal(restRaw.issues.length, 2);
  assert.equal(restRaw.openPulls.length, 3);
  assert.equal(restRaw.mergedPulls.length, 1);
  assert.equal(restRaw.truncated, false);

  const fallbackSnap = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:10:00Z",
    execGh: async () => {
      throw new Error("gh auth missing");
    },
    request: restRequest,
  });
  assert.equal(fallbackSnap.ok, true);
  assert.equal(fallbackSnap.source, "github-rest");
  assert.equal(fallbackSnap.openPulls[0].ci.state, "PASS");
  // Page 2 CHANGES_REQUESTED overrides Page 1 APPROVED!
  assert.equal(fallbackSnap.openPulls[0].reviewStatus, "CHANGES_REQUESTED");
  assert.equal(fallbackSnap.openPulls[1].ci.state, "UNKNOWN");
  assert.equal(fallbackSnap.openPulls[1].reviewStatus, "UNKNOWN");
  // REST snapshots report unknown queue status/counts and unverified aggregate approval counts
  assert.equal(fallbackSnap.openPulls[0].mergeQueue.known, false);
  assert.equal(fallbackSnap.openPulls[0].mergeQueue.queued, null);
  assert.equal(fallbackSnap.totals.queuedPulls, null);
  assert.equal(fallbackSnap.totals.approvedPulls, null);
  assert.equal(fallbackSnap.milestones.find((m) => m.id === "M02").queuedPulls, null);

  // Rate-limit header parsing, low-remaining detail conservation, and hard 403/429 backoff
  assert.deepEqual(
    parseRateLimitHeaders(
      new Headers({
        "x-ratelimit-remaining": "8",
        "x-ratelimit-reset": "1800000000",
        "retry-after": "30",
      }),
      1_799_999_000_000,
    ),
    {
      remaining: 8,
      resetAtMs: 1_800_000_000_000,
      retryAfterMs: 1_799_999_030_000,
    },
  );

  let detailCallsWhenLow = 0;
  const lowQuotaRaw = await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    nowMs: 1_000_000,
    request: async (url) => {
      if (url.includes("/check-runs") || url.includes("/status") || url.includes("/reviews")) {
        detailCallsWhenLow += 1;
      }
      if (url.includes("/pulls?state=open")) {
        return new Response(
          JSON.stringify([{ number: 1, title: "PR", head: { ref: "b", sha: "f".repeat(40) } }]),
          { headers: { "x-ratelimit-remaining": "8", "x-ratelimit-reset": "2000" } },
        );
      }
      return new Response("[]", {
        headers: { "x-ratelimit-remaining": "8", "x-ratelimit-reset": "2000" },
      });
    },
  });
  assert.equal(detailCallsWhenLow, 0);
  assert.equal(lowQuotaRaw.rateLimit.remaining, 8);
  assert.ok(lowQuotaRaw.rateLimit.nextPollAtMs > 1_000_000);

  const sharedRateState = { blockedUntilMs: 0, nextPollAtMs: 0 };
  let rateLimitedRestHits = 0;
  const rlSnap1 = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:00:00Z",
    rateLimitState: sharedRateState,
    execGh: async () => {
      throw new Error("no gh");
    },
    request: async () => {
      rateLimitedRestHits += 1;
      return new Response("rate limit", {
        status: 403,
        headers: { "x-ratelimit-remaining": "0", "retry-after": "120" },
      });
    },
  });
  assert.equal(rlSnap1.ok, false);
  assert.equal(rlSnap1.error.code, "REST_RATE_LIMITED");
  assert.equal(rateLimitedRestHits, 1);

  // Subsequent poll during backoff window makes zero HTTP requests
  const rlSnap2 = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:00:30Z",
    rateLimitState: sharedRateState,
    execGh: async () => {
      throw new Error("no gh");
    },
    request: async () => {
      rateLimitedRestHits += 1;
      throw new Error("should not call REST while backed off");
    },
  });
  assert.equal(rlSnap2.error.code, "REST_RATE_LIMITED");
  assert.equal(rateLimitedRestHits, 1);

  // 200 OK exhausting last remaining quota unit sets blockedUntilMs on rateLimitState
  const lastUnitState = { blockedUntilMs: 0, nextPollAtMs: 0 };
  const lastUnitSnap = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:01:00Z",
    rateLimitState: lastUnitState,
    execGh: async () => {
      throw new Error("no gh");
    },
    request: async () =>
      new Response("[]", {
        status: 200,
        headers: { "x-ratelimit-remaining": "0" },
      }),
  });
  assert.equal(lastUnitSnap.ok, true);
  assert.ok(lastUnitState.blockedUntilMs > Date.parse("2026-11-27T01:01:00Z"));

  // Authenticated gh success clears REST backoff state
  const emptyValidGqlRepo = {
    milestones: { pageInfo: { hasNextPage: false }, nodes: [] },
    openIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    closedIssues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
    openPulls: { pageInfo: { hasNextPage: false }, nodes: [] },
    mergedPulls: { nodes: [] },
  };
  const rlCleared = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:00:40Z",
    rateLimitState: sharedRateState,
    execGh: async () => JSON.stringify({ data: { repository: emptyValidGqlRepo } }),
  });
  assert.equal(rlCleared.ok, true);
  assert.equal(sharedRateState.blockedUntilMs, 0);

  // Truncated REST reviews fail closed to UNKNOWN; truncated issues mark partial
  const truncatedRestRaw = await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    maxPages: 1,
    maxReviewPages: 1,
    perPage: 1,
    request: async (url) => {
      if (url.includes("/pulls?state=closed")) return new Response("[]");
      if (url.includes("/pulls?state=open")) {
        return new Response(
          JSON.stringify([{ number: 1, title: "PR", head: { ref: "b", sha: "e".repeat(40) } }]),
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(JSON.stringify({ total_count: 1, check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }));
      }
      if (url.includes("/status")) {
        return new Response(JSON.stringify({ state: "pending", total_count: 0, statuses: [] }));
      }
      if (url.includes("/reviews")) {
        return new Response(JSON.stringify([{ user: { login: "r" }, state: "APPROVED" }]));
      }
      return new Response(JSON.stringify([{ number: 1, title: "M01 - Auto", state: "open" }]));
    },
  });
  assert.equal(truncatedRestRaw.truncated, true);
  assert.equal(truncatedRestRaw.openPulls[0].reviews, undefined);

  // 429 on detail sub-request without headers persists 60s backoff in rateLimit
  const detail429Raw = await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    nowMs: 1_000_000,
    request: async (url) => {
      if (url.includes("/pulls?state=open")) {
        return new Response(
          JSON.stringify([{ number: 7, title: "PR", head: { ref: "b", sha: "a".repeat(40) } }]),
        );
      }
      if (url.includes("/check-runs")) {
        return new Response("throttled", { status: 429 });
      }
      return new Response("[]");
    },
  });
  assert.equal(detail429Raw.rateLimit.blockedUntilMs, 1_060_000);
  assert.equal(detail429Raw.rateLimit.nextPollAtMs, 1_060_000);

  // Remaining quota of 11 (only 1 above 10-request reserve) skips 5-request detail reads
  let detailCallsAt11 = 0;
  await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    request: async (url) => {
      if (url.includes("/commits/") || url.includes("/reviews")) {
        detailCallsAt11 += 1;
      }
      if (url.includes("/pulls?state=open")) {
        return new Response(
          JSON.stringify([{ number: 8, title: "PR", head: { ref: "b", sha: "b".repeat(40) } }]),
          { headers: { "x-ratelimit-remaining": "11" } },
        );
      }
      return new Response("[]", { headers: { "x-ratelimit-remaining": "11" } });
    },
  });
  assert.equal(detailCallsAt11, 0);

  // Closed PR pagination walks past unmerged closures and marks truncated when cap reached
  const pagedClosedRaw = await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    maxPages: 2,
    perPage: 1,
    request: async (url) => {
      if (url.includes("/pulls?state=closed")) {
        if (url.includes("&page=1")) {
          return new Response(JSON.stringify([{ number: 1, title: "Closed unmerged", merged_at: null }]), {
            headers: { link: '<https://api.github.com/next>; rel="next"' },
          });
        }
        return new Response(
          JSON.stringify([{ number: 2, title: "Merged on page 2", merged_at: "2026-11-27T00:00:00Z", head: { ref: "m" } }]),
          { headers: { link: '<https://api.github.com/next2>; rel="next"' } },
        );
      }
      return new Response("[]");
    },
  });
  assert.equal(pagedClosedRaw.mergedPulls.length, 1);
  assert.equal(pagedClosedRaw.mergedPulls[0].number, 2);
  assert.equal(pagedClosedRaw.truncated, true);

  // Deduplicate repeated open & merged PRs across updated-descending pages before detail/window caps
  let openDetailCalls = 0;
  const dedupedRestRaw = await fetchViaPublicRest({
    owner: "Jamula",
    name: "SoftwareFactory",
    maxPages: 2,
    perPage: 10,
    maxDetailPulls: 2,
    request: async (url) => {
      if (url.includes("/commits/")) {
        openDetailCalls += 1;
        return new Response(JSON.stringify({ total_count: 0, check_runs: [], state: "pending", statuses: [] }));
      }
      if (url.includes("/reviews")) {
        return new Response("[]");
      }
      if (url.includes("/pulls?state=open")) {
        if (url.includes("&page=1")) {
          return new Response(
            JSON.stringify([{ number: 50, title: "Open 50", head: { ref: "b1", sha: "a".repeat(40) } }]),
            { headers: { link: '<https://api.github.com/next>; rel="next"' } },
          );
        }
        return new Response(
          JSON.stringify([
            { number: 50, title: "Open 50 dup", head: { ref: "b1", sha: "a".repeat(40) } },
            { number: 51, title: "Open 51", head: { ref: "b2", sha: "b".repeat(40) } },
          ]),
        );
      }
      if (url.includes("/pulls?state=closed")) {
        if (url.includes("&page=1")) {
          return new Response(
            JSON.stringify([
              ...Array.from({ length: 11 }, (_, idx) => ({
                number: idx + 1,
                title: `Merged ${idx + 1}`,
                merged_at: "2026-11-27T00:00:00Z",
                head: { ref: "m" },
              })),
              { number: 1, title: "Merged 1 dup", merged_at: "2026-11-27T00:00:00Z", head: { ref: "m" } },
            ]),
            { headers: { link: '<https://api.github.com/next>; rel="next"' } },
          );
        }
        return new Response(
          JSON.stringify([{ number: 12, title: "Merged 12", merged_at: "2026-11-27T00:00:00Z", head: { ref: "m" } }]),
        );
      }
      return new Response("[]");
    },
  });
  assert.equal(dedupedRestRaw.openPulls.length, 2);
  // 2 check/status calls per distinct open PR = 4 total (duplicate #50 did not spend quota)
  assert.equal(openDetailCalls, 4);
  assert.equal(dedupedRestRaw.mergedPulls.length, 12);
  assert.equal(new Set(dedupedRestRaw.mergedPulls.map((p) => p.number)).size, 12);
  // buildFactoryBoardSnapshot also deduplicates raw openPulls/mergedPulls defensively
  const dedupedSnap = buildFactoryBoardSnapshot(
    {
      milestones: [],
      issues: [],
      openPulls: [
        { number: 50, title: "Open 50" },
        { number: 50, title: "Open 50 dup" },
      ],
      mergedPulls: [
        { number: 12, title: "Merged 12" },
        { number: 12, title: "Merged 12 dup" },
      ],
    },
    { repo: DEFAULT_REPO, source: "github-rest", generatedAt: "2026-11-27T01:00:00Z" },
  );
  assert.equal(dedupedSnap.openPulls.length, 1);
  assert.equal(dedupedSnap.mergedPulls.length, 1);

  await assert.rejects(
    () =>
      fetchViaPublicRest({
        owner: "Jamula",
        name: "SoftwareFactory",
        request: async () => new Response(JSON.stringify({ notArray: true })),
      }),
    /REST_PAYLOAD_INVALID/,
  );
  await assert.rejects(
    () =>
      fetchViaPublicRest({
        owner: "Jamula",
        name: "SoftwareFactory",
        request: async (url) =>
          url.includes("state=closed")
            ? new Response(JSON.stringify({ notArray: true }))
            : new Response("[]"),
      }),
    /REST_PAYLOAD_INVALID/,
  );

  // Invalid repo slug fails closed and emits sanitized INVALID_EVIDENCE observation
  const badSlugSnap = await fetchFactoryBoardSnapshot({
    repo: "invalid slug",
    clock: () => "2026-11-27T01:12:00Z",
    observe: captureObserve,
  });
  assert.equal(badSlugSnap.ok, false);
  assert.equal(badSlugSnap.error.code, "INVALID_REPO_SLUG");
  assert.deepEqual(observedSummaries.at(-1), {
    stage: "reconcile",
    outcome: "blocked",
    reason: "INVALID_EVIDENCE",
  });

  // Both gh and REST failing preserves previousSnapshot with stale: true and emits RUNTIME failure observation
  const bothFailed = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:15:00Z",
    observe: captureObserve,
    execGh: async () => {
      throw new Error("gh failed");
    },
    request: async () => {
      throw "non-error-rejection";
    },
    previousSnapshot: fallbackSnap,
  });
  assert.equal(bothFailed.ok, false);
  assert.equal(bothFailed.stale, true);
  assert.equal(bothFailed.error.code, "SNAPSHOT_FETCH_FAILED");

  // When remaining=0 and both retry-after and x-ratelimit-reset are present, enforce the later deadline
  await assert.rejects(
    () =>
      fetchViaPublicRest({
        owner: "Jamula",
        name: "SoftwareFactory",
        nowMs: 1_700_000_000_000,
        request: async () =>
          new Response("rate limit", {
            status: 403,
            headers: {
              "retry-after": "30",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1700003600",
            },
          }),
      }),
    (err) => err.code === "REST_RATE_LIMITED" && err.blockedUntilMs === 1_700_003_600_000,
  );

  // Offline subprocess test for defaultExecGh error fallback, GH_HOST=github.com pinning, and success path
  const emptyConn = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const gqlOk = JSON.stringify({
    data: {
      repository: {
        milestones: emptyConn,
        openIssues: emptyConn,
        closedIssues: emptyConn,
        openPulls: emptyConn,
        mergedPulls: { nodes: [] },
      },
    },
  });
  const cpLoaderSource = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "node:child_process") {
          return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
            "let n = 0; const gqlOk = " + ${JSON.stringify(JSON.stringify(gqlOk))} + ";" +
            "export function execFile(cmd, args, opts, cb) {" +
            "  if (cmd !== 'gh' || args[1] !== '--hostname' || args[2] !== 'github.com' || opts?.env?.GH_HOST !== 'github.com') {" +
            "    cb(new Error('unpinned gh host'), '', ''); return;" +
            "  }" +
            "  n += 1; if (n === 1) cb(new Error('stubbed offline gh failure'), '', 'err'); else cb(null, gqlOk, '');" +
            "}"
          )};
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const cpLoaderUrl = `data:text/javascript,${encodeURIComponent(cpLoaderSource)}`;
  const boardModuleUrl = new URL("../../tools/engineering-factory/factory-board.mjs", import.meta.url).href;
  const offlineRunner = `
    import assert from "node:assert/strict";
    import { DEFAULT_REPO, fetchFactoryBoardSnapshot } from ${JSON.stringify(boardModuleUrl)};
    process.env.GH_HOST = "ghe.example.internal";
    const fallbackRes = await fetchFactoryBoardSnapshot({
      repo: DEFAULT_REPO,
      clock: () => "2026-11-27T01:20:00Z",
      request: async () => new Response("[]"),
    });
    assert.equal(fallbackRes.ok, true);
    assert.equal(fallbackRes.source, "github-rest");
    const directRes = await fetchFactoryBoardSnapshot({
      repo: DEFAULT_REPO,
      clock: () => "2026-11-27T01:21:00Z",
    });
    assert.equal(directRes.ok, true);
    assert.equal(directRes.source, "gh-graphql");
  `;
  await execFileAsync(process.execPath, ["--import", cpLoaderUrl, "--input-type=module", "-e", offlineRunner]);
});

test("createBoardPoller coalesces concurrent refreshes, reschedules intervals, pauses, and cleans up timers", async () => {
  assert.throws(() => createBoardPoller({ intervalSeconds: 5 }), /between 10 and 300/);

  let scheduledFn = null;
  let scheduledMs = 0;
  let clearedCount = 0;
  let unrefCalled = false;
  const fakeTimers = {
    setInterval(fn, ms) {
      scheduledFn = fn;
      scheduledMs = ms;
      return {
        id: 1,
        unref() {
          unrefCalled = true;
        },
      };
    },
    clearInterval() {
      clearedCount += 1;
      scheduledFn = null;
    },
  };

  let fetchCalls = 0;
  let releaseFetch;
  const gate = new Promise((r) => {
    releaseFetch = r;
  });

  const poller = createBoardPoller({
    repo: DEFAULT_REPO,
    intervalSeconds: DEFAULT_INTERVAL_SECONDS,
    timers: fakeTimers,
    fetchSnapshot: async ({ repo }) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        await gate;
      }
      return buildFactoryBoardSnapshot(
        { milestones: [], issues: [], openPulls: [], mergedPulls: [] },
        { repo, source: "gh-graphql", generatedAt: `2026-11-27T01:00:0${fetchCalls}Z` },
      );
    },
  });

  assert.equal(poller.getSummary(), null);

  const events = [];
  const unsubscribe = poller.subscribe((env) => events.push(env));

  const p1 = poller.start();
  const p2 = poller.refresh();
  assert.equal(scheduledMs, 20_000);
  assert.equal(unrefCalled, true);

  releaseFetch();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(fetchCalls, 1);
  assert.equal(r1.snapshot.generatedAt, r2.snapshot.generatedAt);
  assert.equal(events.length, 1);
  assert.equal(poller.getSummary().ok, true);

  // Trigger timer tick
  assert.equal(typeof scheduledFn, "function");
  scheduledFn();
  await poller.refresh();
  assert.equal(fetchCalls, 2);

  // Invalid and valid interval changes
  assert.equal(poller.setIntervalSeconds(999).valid, false);
  const updated = poller.setIntervalSeconds(45);
  assert.equal(updated.valid, true);
  assert.equal(updated.status, "Auto-refreshing (45s)");
  assert.equal(scheduledMs, 45_000);

  // Pause & resume
  assert.equal(poller.setPaused(true).status, "Paused");
  assert.equal(scheduledFn, null);
  assert.equal(poller.setPaused(false).status, "Auto-refreshing (45s)");
  assert.equal(typeof scheduledFn, "function");

  unsubscribe();
  const countBeforeClose = events.length;
  poller.close();
  assert.ok(clearedCount >= 2);
  const afterClose = await poller.refresh();
  assert.equal(afterClose.config.intervalSeconds, 45);
  assert.equal(events.length, countBeforeClose);

  // Rate-limit paced background timer skips early ticks until nextPollAtMs
  let fakeNowMs = 10_000;
  let pacedFetchCount = 0;
  let pacedTick = null;
  const pacedPoller = createBoardPoller({
    repo: DEFAULT_REPO,
    intervalSeconds: 10,
    now: () => fakeNowMs,
    timers: {
      setInterval(fn) {
        pacedTick = fn;
        return { unref() {} };
      },
      clearInterval() {},
    },
    fetchSnapshot: async ({ repo }) => {
      pacedFetchCount += 1;
      return {
        ...buildFactoryBoardSnapshot(
          { milestones: [], issues: [], openPulls: [], mergedPulls: [] },
          { repo, source: "github-rest", generatedAt: "2026-11-27T01:00:00Z" },
        ),
        rateLimit: { nextPollAtMs: 50_000, blockedUntilMs: 0 },
      };
    },
  });
  await pacedPoller.start();
  assert.equal(pacedFetchCount, 1);
  // Early tick at 20_000 (< 50_000) is skipped
  fakeNowMs = 20_000;
  pacedTick();
  assert.equal(pacedFetchCount, 1);
  // Tick at 50_000 proceeds
  fakeNowMs = 50_000;
  pacedTick();
  await pacedPoller.refresh();
  assert.equal(pacedFetchCount, 2);
  pacedPoller.close();
});

test("board-ui loopback HTTP/SSE server and createFactoryBoardCanvasSpec satisfy Copilot CLI canvas rules", async () => {
  // Verify extension structural invariants: no package.json, no console.log in extension.mjs or board-ui.mjs
  const extDir = join(process.cwd(), ".github", "extensions", "factory-board");
  assert.equal(existsSync(join(extDir, "package.json")), false);
  for (const file of ["extension.mjs", "board-ui.mjs"]) {
    const src = readFileSync(join(extDir, file), "utf8");
    assert.equal(/\bconsole\.log\b/.test(src), false, `${file} must not call console.log`);
  }
  await execFileAsync(process.execPath, ["--check", join(extDir, "extension.mjs")]);

  const html = renderBoardHtml({ title: 'Board <"Test">', repo: "Jamula/SoftwareFactory" });
  assert.match(html, /--status-bar-color:\s*var\(--background-color-default/);
  assert.match(html, /--true-color-blue/);
  assert.match(html, /--true-color-red/);
  assert.match(html, /Board &lt;&quot;Test&quot;&gt;/);

  let ticks = 0;
  const fakeFetchSnapshot = async ({ repo }) => {
    ticks += 1;
    return buildFactoryBoardSnapshot(
      {
        milestones: [{ number: 2, title: "M01 - Autonomous SoftwareFactory", state: "OPEN" }],
        issues: [{ number: 5, title: "[M01.03] Event orch", state: "OPEN", labels: ["M01", "P0"] }],
        openPulls: [
          {
            number: 132,
            title: "[M01.03] Shadow event (#5)",
            isDraft: false,
            headRefName: "u/dev/test",
            reviewDecision: "APPROVED",
            mergeStateStatus: "CLEAN",
            checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
          },
        ],
        mergedPulls: [],
      },
      { repo, source: "gh-graphql", generatedAt: `2026-11-27T02:00:0${ticks}Z` },
    );
  };

  const logs = [];
  const manager = createBoardInstanceManager({
    fetchSnapshot: fakeFetchSnapshot,
    onLog: (msg) => logs.push(msg),
  });
  const spec = createFactoryBoardCanvasSpec({ CanvasError: MockCanvasError, manager });

  assert.equal(spec.id, CANVAS_ID);
  assert.equal(spec.displayName, CANVAS_DISPLAY_NAME);
  assert.equal(spec.description, CANVAS_DESCRIPTION);
  for (const action of spec.actions) {
    assert.equal(action.name.startsWith("canvas."), false);
  }

  const refreshAction = spec.actions.find((a) => a.name === "refresh");
  const setIntervalAction = spec.actions.find((a) => a.name === "set_interval");

  // Calling actions before opening fails with CanvasError
  await assert.rejects(
    () => refreshAction.handler({ instanceId: "missing-1" }),
    (err) => err instanceof MockCanvasError && err.code === "instance_not_found",
  );
  await assert.rejects(
    () => setIntervalAction.handler({ instanceId: "missing-1", input: { intervalSeconds: 30 } }),
    (err) => err instanceof MockCanvasError && err.code === "instance_not_found",
  );
  await assert.rejects(
    () => spec.open({ instanceId: "" }),
    (err) => err instanceof MockCanvasError,
  );
  await assert.rejects(
    () => spec.open({ instanceId: "bad-int", input: { intervalSeconds: 3 } }),
    (err) => err instanceof MockCanvasError && err.code === "invalid_interval",
  );

  // Open canvas instance and verify loopback 127.0.0.1 URL + default 20s status
  const opened = await spec.open({ canvasId: "factory-board", instanceId: "inst-1" });
  assert.equal(opened.title, "SoftwareFactory Live Board");
  assert.equal(opened.status, "Auto-refreshing (20s)");
  assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  // Idempotent reopen returns same server URL and honors updated interval (omitted or matching repo)
  const reopened = await spec.open({
    canvasId: "factory-board",
    instanceId: "inst-1",
    input: { repo: DEFAULT_REPO, intervalSeconds: 25 },
  });
  assert.equal(reopened.url, opened.url);
  assert.equal(reopened.status, "Auto-refreshing (25s)");

  // Reopening existing instanceId with a different explicit repo fails with repo_conflict
  await assert.rejects(
    () =>
      spec.open({
        canvasId: "factory-board",
        instanceId: "inst-1",
        input: { repo: "Jamula/FamilyTree" },
      }),
    (err) => err instanceof MockCanvasError && err.code === "repo_conflict",
  );

  // Connect live SSE viewer to /events
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${opened.url}events`, { signal: sseAbort.signal });
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
  const sseReader = sseRes.body.getReader();
  const sseDecoder = new TextDecoder();
  const firstChunk = await sseReader.read();
  assert.match(sseDecoder.decode(firstChunk.value), /event: state/);

  // Test HTTP GET /, GET /client.mjs, GET /api/state, Host/Origin/CSRF/CSP framing protections, and POST routes
  const htmlRes = await fetch(opened.url);
  assert.equal(htmlRes.status, 200);
  assert.match(htmlRes.headers.get("content-security-policy") ?? "", /frame-ancestors 'self' tauri:\/\/localhost/);
  const htmlBody = await htmlRes.text();
  assert.match(htmlBody, /SoftwareFactory Live Board/);
  const tokenMatch = /data-board-token="([a-f0-9]+)"/.exec(htmlBody);
  assert.ok(tokenMatch, "HTML body must embed per-instance capability token");
  const boardToken = tokenMatch[1];

  // Unapproved external Referer or cross-site non-iframe request on GET / is rejected (403)
  const evilFrameRes = await fetch(opened.url, {
    headers: { Referer: "https://evil.example/clickjack.html", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(evilFrameRes.status, 403);
  const brokenRefererRes = await fetch(opened.url, {
    headers: { Referer: "://invalid" },
  });
  assert.equal(brokenRefererRes.status, 403);
  const approvedTauriFrameRes = await fetch(opened.url, {
    headers: { Referer: "tauri://localhost/index.html", "Sec-Fetch-Dest": "iframe", "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(approvedTauriFrameRes.status, 200);
  const approvedSameOriginFrameRes = await fetch(opened.url, {
    headers: { Referer: opened.url },
  });
  assert.equal(approvedSameOriginFrameRes.status, 200);
  const approvedHttpsTauriFrameRes = await fetch(opened.url, {
    headers: { Referer: "https://tauri.localhost/panel" },
  });
  assert.equal(approvedHttpsTauriFrameRes.status, 200);
  const crossSiteTopRes = await fetch(opened.url, {
    headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Dest": "document" },
  });
  assert.equal(crossSiteTopRes.status, 403);

  const clientJsRes = await fetch(`${opened.url}client.mjs`);
  assert.equal(clientJsRes.status, 200);
  assert.match(clientJsRes.headers.get("content-type") ?? "", /text\/javascript/);
  assert.match(await clientJsRes.text(), /initFactoryBoardClient/);

  // DNS rebinding / Host mismatch, cross-origin, cross-site, Content-Type, and token checks
  const rebindRes = await new Promise((resolve, reject) => {
    const u = new URL(opened.url);
    import("node:http").then(({ request }) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: u.port,
          path: "/api/state",
          method: "GET",
          headers: { Host: `evil.example:${u.port}` },
        },
        (res) => resolve(res.statusCode),
      );
      req.on("error", reject);
      req.end();
    });
  });
  assert.equal(rebindRes, 403);

  const badOriginRes = await fetch(`${opened.url}api/state`, {
    headers: { Origin: "https://evil.example" },
  });
  assert.equal(badOriginRes.status, 403);

  const crossSiteSubresourceRes = await fetch(`${opened.url}api/state`, {
    headers: { "Sec-Fetch-Site": "cross-site" },
  });
  assert.equal(crossSiteSubresourceRes.status, 403);

  const textPlainPostRes = await fetch(`${opened.url}api/refresh`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", "X-Factory-Board-Token": boardToken },
    body: "{}",
  });
  assert.equal(textPlainPostRes.status, 415);

  const missingTokenPostRes = await fetch(`${opened.url}api/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missingTokenPostRes.status, 403);

  const stateRes = await fetch(`${opened.url}api/state`);
  assert.equal(stateRes.status, 200);
  const stateJson = await stateRes.json();
  assert.equal(stateJson.snapshot.totals.openPulls, 1);

  const authedHeaders = {
    "Content-Type": "application/json",
    "X-Factory-Board-Token": boardToken,
    Origin: opened.url.slice(0, -1),
  };

  const postRefreshRes = await fetch(`${opened.url}api/refresh`, {
    method: "POST",
    headers: authedHeaders,
    body: "",
  });
  assert.equal(postRefreshRes.status, 200);

  // Read pushed SSE update triggered by /api/refresh
  const secondChunk = await sseReader.read();
  assert.match(sseDecoder.decode(secondChunk.value), /event: state/);

  const pauseRes = await fetch(`${opened.url}api/control`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({ paused: true, intervalSeconds: 30 }),
  });
  assert.equal(pauseRes.status, 200);
  const pauseJson = await pauseRes.json();
  assert.equal(pauseJson.config.paused, true);
  assert.equal(pauseJson.config.status, "Paused");

  const badIntervalHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    headers: authedHeaders,
    body: JSON.stringify({ intervalSeconds: 2 }),
  });
  assert.equal(badIntervalHttp.status, 400);

  const badJsonHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    headers: authedHeaders,
    body: "{broken",
  });
  assert.equal(badJsonHttp.status, 400);

  const arrayJsonHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    headers: authedHeaders,
    body: "[]",
  });
  assert.equal(arrayJsonHttp.status, 400);

  const tooLargeHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    headers: authedHeaders,
    body: "x".repeat(5000),
  });
  assert.equal(tooLargeHttp.status, 413);

  const notFoundRes = await fetch(`${opened.url}unknown`);
  assert.equal(notFoundRes.status, 404);

  // Test Canvas actions: refresh returns raw summary (not wrapped in { ok, result })
  const actionSummary = await refreshAction.handler({
    canvasId: "factory-board",
    instanceId: "inst-1",
  });
  assert.equal(actionSummary.repo, DEFAULT_REPO);
  assert.equal(Object.hasOwn(actionSummary, "result"), false);
  assert.equal(actionSummary.milestones[0].id, "M01");

  // Test set_interval action bounds & CanvasError("invalid_interval", ...)
  await assert.rejects(
    () => setIntervalAction.handler({ instanceId: "inst-1", input: { intervalSeconds: 5 } }),
    (err) => err instanceof MockCanvasError && err.code === "invalid_interval",
  );
  await assert.rejects(
    () => setIntervalAction.handler({ instanceId: "inst-1", input: { intervalSeconds: 301 } }),
    (err) => err instanceof MockCanvasError && err.code === "invalid_interval",
  );

  const intervalResult = await setIntervalAction.handler({
    instanceId: "inst-1",
    input: { intervalSeconds: 60 },
  });
  assert.equal(intervalResult.intervalSeconds, 60);

  sseAbort.abort();
  await sseReader.cancel().catch(() => {});

  // Close instance and ensure clean teardown
  await spec.onClose({ instanceId: "inst-1" });
  assert.equal(manager.size(), 0);
  await manager.closeAll();

  // Concurrent openInstance coalescing and cancellation during pending startup
  let startCalls = 0;
  let releaseStartup;
  const startupGate = new Promise((r) => {
    releaseStartup = r;
  });
  let closedCancelledServer = false;
  const coalescedManager = createBoardInstanceManager({
    startServer: async (opts) => {
      startCalls += 1;
      await startupGate;
      const real = await startLoopbackBoardServer({ ...opts, fetchSnapshot: fakeFetchSnapshot });
      return {
        ...real,
        async close() {
          closedCancelledServer = true;
          await real.close();
        },
      };
    },
  });

  const [concurrentA, concurrentB] = [
    coalescedManager.openInstance({ instanceId: "race-1" }),
    coalescedManager.openInstance({ instanceId: "race-1", input: { intervalSeconds: 35 } }),
  ];
  await assert.rejects(
    () =>
      coalescedManager.openInstance({
        instanceId: "race-1",
        input: { repo: "Jamula/FamilyTree" },
      }),
    (err) => err?.code === "repo_conflict",
  );
  releaseStartup();
  const [resA, resB] = await Promise.all([concurrentA, concurrentB]);
  assert.equal(startCalls, 1);
  assert.equal(resA.url, resB.url);
  assert.equal(resB.status, "Auto-refreshing (35s)");
  await coalescedManager.closeAll();

  // Cancel while startup is still in flight
  let releaseCancelGate;
  const cancelGate = new Promise((r) => {
    releaseCancelGate = r;
  });
  closedCancelledServer = false;
  const cancelManager = createBoardInstanceManager({
    startServer: async (opts) => {
      await cancelGate;
      const real = await startLoopbackBoardServer({ ...opts, fetchSnapshot: fakeFetchSnapshot });
      return {
        ...real,
        async close() {
          closedCancelledServer = true;
          await real.close();
        },
      };
    },
  });
  const pendingOpen = cancelManager.openInstance({ instanceId: "cancel-1" });
  const closePromise = cancelManager.closeInstance("cancel-1");
  releaseCancelGate();
  await assert.rejects(() => pendingOpen, /closed during startup/);
  assert.equal(await closePromise, true);
  assert.equal(closedCancelledServer, true);
  assert.equal(cancelManager.size(), 0);

  // Direct startLoopbackBoardServer with slow initial snapshot + active SSE keepalive + close with live SSE client
  let releaseSlowSnap;
  const slowSnapGate = new Promise((r) => {
    releaseSlowSnap = r;
  });
  const intervalCallbacks = [];
  const customTimers = {
    setInterval(fn) {
      intervalCallbacks.push(fn);
      return { id: intervalCallbacks.length, unref() {} };
    },
    clearInterval() {},
  };
  const standalone = await startLoopbackBoardServer({
    standalone: true,
    timers: customTimers,
    fetchSnapshot: async (opts) => {
      await slowSnapGate;
      return fakeFetchSnapshot(opts);
    },
  });
  const standaloneRootRes = await fetch(standalone.url);
  assert.equal(standaloneRootRes.headers.get("x-frame-options"), "DENY");
  assert.match(standaloneRootRes.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  const standaloneIframeBlocked = await fetch(standalone.url, {
    headers: { "Sec-Fetch-Dest": "iframe" },
  });
  assert.equal(standaloneIframeBlocked.status, 403);
  const emptyAncestorsServer = await startLoopbackBoardServer({
    frameAncestors: [],
    timers: customTimers,
    fetchSnapshot: fakeFetchSnapshot,
  });
  await emptyAncestorsServer.close();
  const liveSsePromise = fetch(`${standalone.url}events`);
  const liveSseRes = await liveSsePromise;
  const liveSseReader = liveSseRes.body.getReader();
  const initialNullChunk = await liveSseReader.read();
  assert.match(new TextDecoder().decode(initialNullChunk.value), /"snapshot":null/);
  // Trigger SSE keepAlive callback
  intervalCallbacks.at(-1)();
  const keepAliveChunk = await liveSseReader.read();
  assert.match(new TextDecoder().decode(keepAliveChunk.value), /: keepalive/);

  const pendingStateFetch = fetch(`${standalone.url}api/state`);
  releaseSlowSnap();
  const resolvedStateRes = await pendingStateFetch;
  assert.equal(resolvedStateRes.status, 200);
  // Close server while SSE stream is still open to verify server-initiated SSE cleanup
  await standalone.close();
  await standalone.close();
  await liveSseReader.cancel().catch(() => {});
  assert.ok(logs.length >= 1);

  // Deterministic SSE backpressure coalescing, oversized state_notify fallback, & slow-viewer disconnection
  let clearedTimers = 0;
  const reg = createSseClientRegistry({
    timers: { setInterval: () => 1, clearInterval: () => { clearedTimers += 1; } },
    maxBufferBytes: 128,
  });
  const writtenFrames = [];
  let drainListener = null;
  let flushNext = false;
  let destroyedCount = 0;
  const slowRes = {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    write(frame) {
      writtenFrames.push(frame);
      if (!flushNext) {
        this.writableLength = 32;
        return false;
      }
      this.writableLength = 0;
      return true;
    },
    once(ev, cb) {
      if (ev === "drain") drainListener = cb;
    },
    destroy() {
      this.destroyed = true;
      destroyedCount += 1;
    },
    end() {
      this.writableEnded = true;
    },
  };
  reg.add(slowRes, 101);
  // Initial state frame hits backpressure (returns false)
  reg.broadcastState("event: state\ndata: {\"v\":1}\n\n");
  // Keepalive while backpressured is dropped; state frames coalesce to latest (v=3)
  reg.write(slowRes, ": keepalive\n\n");
  reg.broadcastState("event: state\ndata: {\"v\":2}\n\n");
  reg.broadcastState("event: state\ndata: {\"v\":3}\n\n");
  assert.deepEqual(writtenFrames, ["event: state\ndata: {\"v\":1}\n\n"]);
  flushNext = true;
  drainListener();
  assert.deepEqual(writtenFrames, [
    "event: state\ndata: {\"v\":1}\n\n",
    "event: state\ndata: {\"v\":3}\n\n",
  ]);
  // Oversized state snapshot (> maxBufferBytes) sends compact state_notify WITHOUT disconnecting healthy viewer
  const largeFrame = `event: state\ndata: ${JSON.stringify({ huge: "x".repeat(256) })}\n\n`;
  reg.broadcastState(largeFrame);
  assert.equal(destroyedCount, 0);
  assert.equal(reg.size(), 1);
  assert.equal(writtenFrames.at(-1), 'event: state_notify\ndata: {"pull":true}\n\n');
  // Drain with no pending frame is a clean no-op
  flushNext = false;
  reg.write(slowRes, ": keepalive\n\n");
  flushNext = true;
  drainListener();
  // Exceeded unread writableLength disconnects slow viewer immediately
  slowRes.writableLength = 256;
  reg.write(slowRes, ": keepalive\n\n");
  assert.equal(destroyedCount, 1);
  assert.equal(reg.size(), 0);
  assert.equal(clearedTimers, 1);
  // Post-write writableLength overflow also disconnects immediately
  const overflowRes = {
    destroyed: false,
    writableEnded: false,
    writableLength: 0,
    write() {
      this.writableLength = 512;
      return false;
    },
    once() {},
    destroy() {
      this.destroyed = true;
      destroyedCount += 1;
    },
    end() {},
  };
  reg.add(overflowRes, 102);
  reg.broadcastState("event: state\ndata: {\"v\":4}\n\n");
  assert.equal(destroyedCount, 2);
  assert.equal(reg.size(), 0);
  // Writing to an ended or unregistered response is safely ignored
  reg.write(overflowRes, ": keepalive\n\n");
});

test("initFactoryBoardClient renders verified, partial, stale, and cold-unavailable states and handles UI controls", async () => {
  const makeEl = (tag = "div") => {
    const listeners = new Map();
    const classes = new Set();
    const attrs = new Map();
    const children = [];
    let inner = "";
    let drawers = [];
    let filterButtons = [];
    const node = {
      tagName: tag.toUpperCase(),
      textContent: "",
      className: "",
      hidden: false,
      disabled: false,
      value: "20",
      open: true,
      options: [{ value: "10" }, { value: "20" }, { value: "30" }],
      get innerHTML() {
        return inner;
      },
      set innerHTML(val) {
        inner = String(val);
        drawers = [...inner.matchAll(/data-ms="([^"]+)"/g)].map((m) => {
          const dListeners = new Map();
          return {
            open: true,
            getAttribute: (k) => (k === "data-ms" ? m[1] : null),
            addEventListener: (ev, fn) => dListeners.set(ev, fn),
            triggerToggle(nextOpen) {
              this.open = nextOpen;
              dListeners.get("toggle")?.();
            },
          };
        });
      },
      appendChild(child) {
        children.push(child);
        if (tag === "select") {
          node.options.push(child);
        }
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
      },
      getAttribute(k) {
        return attrs.get(k) ?? null;
      },
      addEventListener(ev, fn) {
        listeners.set(ev, fn);
      },
      async trigger(ev, payload = {}) {
        const fn = listeners.get(ev);
        if (fn) await fn(payload);
      },
      querySelectorAll(sel) {
        if (sel === "details.issue-drawer") return drawers;
        if (sel === "button") return filterButtons;
        if (sel === "[data-focus-key]") {
          return [...inner.matchAll(/data-focus-key="([^"]+)"/g)].map((m) => ({
            getAttribute: (k) => (k === "data-focus-key" ? m[1] : null),
            focus() {
              node.restoredFocusKey = m[1];
            },
          }));
        }
        return [];
      },
      classList: {
        toggle(cls, force) {
          if (force) classes.add(cls);
          else classes.delete(cls);
        },
        has(cls) {
          return classes.has(cls);
        },
      },
      setFilterButtons(btns) {
        filterButtons = btns;
      },
    };
    return node;
  };

  const elements = new Map(
    [
      "sse-dot",
      "sse-text",
      "repo-pill",
      "status-text",
      "toggle-pause",
      "updated-text",
      "source-text",
      "error-banner",
      "kpi-grid",
      "milestones-grid",
      "open-prs-wrap",
      "merged-prs-wrap",
      "refresh-now",
      "pr-filters",
    ].map((id) => [id, makeEl()]),
  );
  elements.set("interval-select", makeEl("select"));

  const filterBtns = ["all", "queue", "fail", "pending", "pass"].map((f) => {
    const b = makeEl("button");
    b.setAttribute("data-filter", f);
    b.closest = () => b;
    return b;
  });
  elements.get("pr-filters").setFilterButtons(filterBtns);

  const bodyEl = makeEl("body");
  bodyEl.setAttribute("data-board-token", "tok-123");

  const sseHandlers = new Map();
  class FakeEventSource {
    constructor(url) {
      this.url = url;
    }
    addEventListener(ev, fn) {
      sseHandlers.set(ev, fn);
    }
  }

  const posted = [];
  let initialStateEnvelope = {
    config: { repo: DEFAULT_REPO, intervalSeconds: 45, paused: false, status: "Auto-refreshing (45s)" },
    snapshot: null,
  };

  const fakeWin = {
    document: {
      activeElement: null,
      body: bodyEl,
      getElementById: (id) => elements.get(id),
      createElement: (tag) => makeEl(tag),
    },
    EventSource: FakeEventSource,
    fetch: async (path, opts) => {
      if (path === "/api/state") {
        return new Response(JSON.stringify(initialStateEnvelope), { status: 200 });
      }
      posted.push({ path, headers: opts.headers, body: JSON.parse(opts.body) });
      return new Response(
        JSON.stringify({
          config: { repo: DEFAULT_REPO, intervalSeconds: 60, paused: true, status: "Paused" },
          snapshot: buildUnavailableSnapshot({
            repo: DEFAULT_REPO,
            generatedAt: "2026-11-27T03:00:00Z",
            error: { code: "OFFLINE", message: "No network" },
            previousSnapshot: null,
          }),
        }),
        { status: 200 },
      );
    },
  };

  const client = initFactoryBoardClient(fakeWin);
  // Calling render() before envelope arrives is a safe no-op
  client.render();

  // Unit assertions on pure client helpers
  assert.equal(client.safeHref("https://github.com/Jamula/SoftwareFactory/pull/1"), "https://github.com/Jamula/SoftwareFactory/pull/1");
  assert.equal(client.safeHref("javascript:alert(1)"), "#");
  assert.equal(client.safeHref("https://evil.example/x"), "#");
  assert.equal(client.safeHref("://broken"), "#");
  assert.equal(client.fmtTime(null), "—");
  assert.equal(client.fmtTime("not-a-date"), "not-a-date");
  assert.match(client.fmtTime("2026-11-27T01:02:03Z"), /2026-11-27 01:02:03 UTC/);

  assert.match(client.ciBadge(null), /UNKNOWN/);
  assert.match(client.ciBadge({ state: "PASS", passed: 3, total: 3 }), /PASS 3\/3/);
  assert.match(client.ciBadge({ state: "FAIL", passed: 1, total: 2 }), /FAIL 1\/2/);
  assert.match(client.ciBadge({ state: "PENDING", passed: 0, total: 0 }), /PENDING/);
  assert.match(client.ciBadge({ state: "UNKNOWN", passed: 0, total: 0 }), /UNKNOWN/);

  assert.match(client.reviewBadge("APPROVED"), /APPROVED/);
  assert.match(client.reviewBadge("HAS_APPROVAL"), /APPROVAL OBSERVED/);
  assert.match(client.reviewBadge("CHANGES_REQUESTED"), /CHANGES REQ/);
  assert.match(client.reviewBadge("REVIEW_REQUIRED"), /REVIEW REQ/);
  assert.match(client.reviewBadge("PENDING"), /PENDING/);
  assert.match(client.reviewBadge("UNKNOWN"), /UNKNOWN/);

  assert.match(client.queueBadge({ mergeQueue: { known: true, queued: true, position: 1 } }), /QUEUED #1/);
  assert.match(client.queueBadge({ mergeQueue: { known: true, queued: true, position: null } }), /QUEUED</);
  assert.match(client.queueBadge({ isDraft: true, mergeQueue: { known: true, queued: false } }), /DRAFT</);
  assert.match(client.queueBadge({ isDraft: true, mergeQueue: { known: false, queued: null } }), /DRAFT · QUEUE UNKNOWN/);
  assert.match(client.queueBadge({ isDraft: false, mergeStateStatus: "DIRTY", autoMerge: true, mergeQueue: { known: true, queued: false } }), /DIRTY · AUTO/);
  assert.match(client.queueBadge({ isDraft: false, mergeStateStatus: "CLEAN", autoMerge: false, mergeQueue: { known: true, queued: false } }), /CLEAN</);
  assert.match(client.queueBadge({ isDraft: false, mergeStateStatus: "CLEAN", autoMerge: false, mergeQueue: { known: false, queued: null } }), /CLEAN · QUEUE UNKNOWN/);
  assert.match(client.queueBadge({ isDraft: false, mergeStateStatus: "BLOCKED", autoMerge: false, mergeQueue: { known: true, queued: false } }), /BLOCKED/);

  // Wait for /api/state initial promise
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(elements.get("updated-text").textContent, "Loading initial snapshot…");
  assert.equal(elements.get("interval-select").value, "45");

  // SSE open / error / bad JSON / rich verified snapshot
  sseHandlers.get("open")();
  assert.equal(elements.get("sse-text").textContent, "Live SSE");
  sseHandlers.get("error")();
  assert.equal(elements.get("sse-text").textContent, "Reconnecting…");
  sseHandlers.get("state")({ data: "{invalid" });
  assert.equal(elements.get("sse-text").textContent, "Stream parse error");

  const richSnap = buildFactoryBoardSnapshot(
    {
      truncated: true,
      milestones: [{ number: 2, title: "M01 - Autonomous SoftwareFactory", state: "OPEN" }],
      issues: [
        { number: 4, title: "[M01.01 P0] Closed item", state: "CLOSED", labels: ["M01", "P0"] },
        { number: 5, title: "[M01.03 P1] Open item", state: "OPEN", labels: ["M01", "P1"] },
        { number: 76, title: "Ordinary unassigned bug", state: "OPEN", labels: [], labelsTruncated: true },
        { number: 77, title: "Closed unassigned item", state: "CLOSED", labels: [] },
      ],
      openPulls: [
        {
          number: 130,
          title: "M01.03: Passing queued (#5)",
          headRefName: "u/dev/1",
          reviewDecision: "APPROVED",
          mergeStateStatus: "CLEAN",
          mergeQueueEntry: { state: "QUEUED", position: 1 },
          checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
        },
        {
          number: 131,
          title: "M01.04: Pending",
          headRefName: "",
          reviewDecision: "REVIEW_REQUIRED",
          checkRollup: { contexts: [{ status: "IN_PROGRESS", conclusion: "" }] },
        },
        {
          number: 132,
          title: "Unmapped failing",
          headRefName: "u/dev/3",
          reviewDecision: "CHANGES_REQUESTED",
          checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
        },
      ],
      mergedPulls: [
        { number: 120, title: "M01.01: Merged", mergedAt: "2026-11-27T00:00:00Z", headRefName: "u/m" },
        { number: 121, title: "Unmapped merged", mergedAt: "2026-11-27T00:01:00Z", headRefName: "" },
      ],
    },
    { repo: DEFAULT_REPO, source: "gh-graphql", generatedAt: "2026-11-27T02:30:00Z" },
  );

  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 20, paused: false, status: "Auto-refreshing (20s)" },
      snapshot: richSnap,
    }),
  });

  assert.equal(elements.get("error-banner").hidden, false);
  assert.match(elements.get("error-banner").textContent, /Partial bounded inventory/);
  assert.match(elements.get("kpi-grid").innerHTML, /Closed Issues \(Proxy\)/);
  assert.match(elements.get("kpi-grid").innerHTML, /≥ 2 closed/);
  // Unassigned / truncated-label issues are rendered in a dedicated card/drawer with LABELS TRUNCATED pill
  assert.match(elements.get("milestones-grid").innerHTML, /Unassigned \/ Unclassified Issues/);
  assert.match(elements.get("milestones-grid").innerHTML, /LABELS TRUNCATED/);
  assert.match(elements.get("milestones-grid").innerHTML, /#76<\/span> Ordinary unassigned bug/);
  // Partial milestone progress bars expose milestone aria-label and aria-valuetext without numeric aria-valuenow
  assert.match(elements.get("milestones-grid").innerHTML, /role="progressbar" aria-label="M01 - Autonomous SoftwareFactory closed issue activity proxy" aria-valuetext="Unknown \(partial inventory\)"/);
  assert.doesNotMatch(elements.get("milestones-grid").innerHTML, /aria-valuenow=/);

  // Toggle milestone drawer closed & open
  const drawers = elements.get("milestones-grid").querySelectorAll("details.issue-drawer");
  drawers[0].triggerToggle(false);
  assert.equal(client.state.openDrawers.has("M01"), false);
  drawers[0].triggerToggle(true);
  assert.equal(client.state.openDrawers.has("M01"), true);

  // Exercise all PR filter tabs + aria-pressed state + non-button click ignore
  assert.equal(filterBtns[0].getAttribute("aria-pressed"), "true");
  assert.equal(filterBtns[1].getAttribute("aria-pressed"), "false");
  await elements.get("pr-filters").trigger("click", { target: { closest: () => null } });
  for (const btn of filterBtns) {
    await elements.get("pr-filters").trigger("click", { target: btn });
  }
  assert.equal(filterBtns[0].getAttribute("aria-pressed"), "false");
  assert.equal(filterBtns[4].getAttribute("aria-pressed"), "true");

  // Trigger Refresh now, Pause toggle, and Interval select (sending X-Factory-Board-Token!)
  await elements.get("refresh-now").trigger("click");
  await elements.get("toggle-pause").trigger("click");
  await elements.get("interval-select").trigger("change", { target: { value: "60" } });

  assert.equal(posted.length, 3);
  assert.equal(posted[0].headers["X-Factory-Board-Token"], "tok-123");
  // Out-of-order HTTP POST responses must NOT overwrite SSE state before ordered SSE delivery
  assert.equal(elements.get("toggle-pause").textContent, "Pause auto-refresh");

  // Ordered SSE delivery of cold-start unavailable state renders unknown placeholders ("—")
  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 60, paused: true, status: "Paused" },
      snapshot: buildUnavailableSnapshot({
        repo: DEFAULT_REPO,
        generatedAt: "2026-11-27T03:00:00Z",
        error: { code: "OFFLINE", message: "No network" },
        previousSnapshot: null,
      }),
    }),
  });
  assert.equal(elements.get("toggle-pause").textContent, "Resume auto-refresh");
  assert.match(elements.get("kpi-grid").innerHTML, /Unavailable until verified read/);
  assert.match(elements.get("milestones-grid").innerHTML, /awaiting verified snapshot/);

  // Also test stale degraded snapshot banner rendering
  const completeSnap = buildFactoryBoardSnapshot(
    {
      milestones: [{ number: 2, title: "M01 - Auto", state: "OPEN" }],
      issues: [{ number: 1, title: "[M01] Closed", state: "CLOSED", labels: ["M01"] }],
      openPulls: [],
      mergedPulls: [],
    },
    { repo: DEFAULT_REPO, source: "gh-graphql", generatedAt: "2026-11-27T02:40:00Z" },
  );
  // Healthy verified snapshot hides error-banner and renders 100% closed proxy
  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 20, paused: false, status: "Auto-refreshing (20s)" },
      snapshot: completeSnap,
    }),
  });
  assert.equal(elements.get("error-banner").hidden, true);
  assert.equal(elements.get("error-banner").textContent, "");
  assert.match(elements.get("kpi-grid").innerHTML, /100% closed \(activity proxy, not verified acceptance\)/);
  assert.match(elements.get("milestones-grid").innerHTML, /role="progressbar" aria-label="M01 - Auto closed issue activity proxy" aria-valuenow="100" aria-valuemin="0" aria-valuemax="100"/);

  const staleDegraded = buildUnavailableSnapshot({
    repo: DEFAULT_REPO,
    generatedAt: "2026-11-27T02:45:00Z",
    error: { code: "TIMEOUT", message: "Slow network" },
    previousSnapshot: completeSnap,
  });
  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 20, paused: false, status: "Auto-refreshing (20s)" },
      snapshot: staleDegraded,
    }),
  });
  assert.match(elements.get("error-banner").textContent, /Degraded \(showing last verified snapshot\)/);
  assert.match(elements.get("kpi-grid").innerHTML, /activity proxy, not verified acceptance/);

  // REST snapshot with unknown mergeQueue renders "Unknown queue" and "Queue unknown"
  const restUnknownQueueSnap = buildFactoryBoardSnapshot(
    {
      milestones: [{ number: 2, title: "M01 - Auto", state: "OPEN" }],
      issues: [],
      openPulls: [{ number: 150, title: "[M01] REST PR", mergeQueueEntry: undefined }],
      mergedPulls: [],
    },
    { repo: DEFAULT_REPO, source: "github-rest", generatedAt: "2026-11-27T02:50:00Z" },
  );
  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 20, paused: false, status: "Auto-refreshing (20s)" },
      snapshot: restUnknownQueueSnap,
    }),
  });
  // Unchanged SSE refresh skips DOM rewrite even when browser serializes boolean open as open=""
  let milestonesDomWrites = 0;
  const origMilestonesEl = elements.get("milestones-grid");
  const baseSetInner = Object.getOwnPropertyDescriptor(origMilestonesEl, "innerHTML").set;
  Object.defineProperty(origMilestonesEl, "innerHTML", {
    get: () => origMilestonesEl._browserNormalizedHtml ?? "",
    set(val) {
      milestonesDomWrites += 1;
      origMilestonesEl._browserNormalizedHtml = String(val).replace(/ open>/g, ' open="">');
      baseSetInner.call(origMilestonesEl, val);
    },
  });
  fakeWin.document.activeElement = {
    getAttribute: (k) => (k === "data-focus-key" ? "ms-summary-M01" : null),
  };
  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 20, paused: false, status: "Auto-refreshing (20s)" },
      snapshot: restUnknownQueueSnap,
    }),
  });
  assert.equal(milestonesDomWrites, 0);
  const updatedFocusSnap = buildFactoryBoardSnapshot(
    {
      milestones: [{ number: 2, title: "M01 - Auto", state: "OPEN" }],
      issues: [
        { number: 9, title: "[M01] New item", state: "OPEN", labels: ["M01"] },
        { number: 10, title: "Plain unassigned item", state: "OPEN", labels: [] },
      ],
      openPulls: [{ number: 150, title: "[M01] REST PR", mergeQueueEntry: undefined }],
      mergedPulls: [],
    },
    { repo: DEFAULT_REPO, source: "github-rest", generatedAt: "2026-11-27T02:51:00Z" },
  );
  sseHandlers.get("state")({
    data: JSON.stringify({
      config: { repo: DEFAULT_REPO, intervalSeconds: 20, paused: false, status: "Auto-refreshing (20s)" },
      snapshot: updatedFocusSnap,
    }),
  });
  assert.equal(elements.get("milestones-grid").restoredFocusKey, "ms-summary-M01");

  // state_notify triggers /api/state pull, and stale lower seq envelopes are ignored
  initialStateEnvelope = {
    seq: 10,
    config: { repo: DEFAULT_REPO, intervalSeconds: 25, paused: false, status: "Auto-refreshing (25s)" },
    snapshot: updatedFocusSnap,
  };
  sseHandlers.get("state_notify")();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(elements.get("interval-select").value, "25");
  // Stale lower-seq envelope must be ignored
  sseHandlers.get("state")({
    data: JSON.stringify({
      seq: 9,
      config: { repo: DEFAULT_REPO, intervalSeconds: 120, paused: true, status: "Paused" },
      snapshot: updatedFocusSnap,
    }),
  });
  assert.equal(elements.get("interval-select").value, "25");
});

test("startFactoryBoardExtension and extension.mjs register canvas, forward logs, and close on session end", async () => {
  const sessionLogs = [];
  let capturedJoinOptions = null;
  let closeAllCalls = 0;
  let capturedOnLog = null;

  const boot = await startFactoryBoardExtension({
    CanvasError: MockCanvasError,
    createCanvas: (spec) => spec,
    createManager: (opts) => {
      capturedOnLog = opts.onLog;
      // Calling onLog before joinSession resolves is a safe no-op
      capturedOnLog("early message", { level: "info" });
      return {
        openInstance: async () => ({ title: CANVAS_DISPLAY_NAME, status: "Auto-refreshing (20s)", url: "http://127.0.0.1:1/" }),
        closeInstance: async () => true,
        closeAll: async () => {
          closeAllCalls += 1;
        },
        refreshInstance: async () => null,
        setInstanceInterval: () => ({ ok: false, code: "instance_not_found", message: "none" }),
      };
    },
    joinSession: async (options) => {
      capturedJoinOptions = options;
      return {
        log(msg, opts) {
          sessionLogs.push({ msg, opts });
        },
      };
    },
  });

  assert.equal(boot.canvas.id, CANVAS_ID);
  assert.equal(capturedJoinOptions.canvases.definitions.length, 1);
  capturedOnLog("runtime warning", { level: "warning", ephemeral: true });
  assert.equal(sessionLogs.length, 1);
  assert.equal(sessionLogs[0].msg, "runtime warning");

  await capturedJoinOptions.hooks.handlers.onSessionEnd();
  assert.equal(closeAllCalls, 1);

  // Verify optional local OTLP telemetry bootstrap & shutdown when OTEL_EXPORTER_OTLP_ENDPOINT is set
  let telemetryShutdownCalls = 0;
  let capturedObserve = null;
  const otelBoot = await startFactoryBoardExtension({
    CanvasError: MockCanvasError,
    createCanvas: (spec) => spec,
    env: {
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "x-otlp-api-key=local-test-key",
    },
    startTelemetry: async () => ({
      observe: async (_stage, work) => work(),
      shutdown: async () => {
        telemetryShutdownCalls += 1;
      },
    }),
    createManager: (opts) => {
      capturedObserve = opts.observe;
      return {
        openInstance: async () => ({ title: CANVAS_DISPLAY_NAME, status: "Auto-refreshing (20s)", url: "http://127.0.0.1:1/" }),
        closeInstance: async () => true,
        closeAll: async () => {},
        refreshInstance: async () => null,
        setInstanceInterval: () => ({ ok: false, code: "instance_not_found", message: "none" }),
      };
    },
    joinSession: async (options) => {
      await options.hooks.handlers.onSessionEnd();
      return { log() {} };
    },
  });
  assert.equal(typeof capturedObserve, "function");
  assert.equal(telemetryShutdownCalls, 1);
  assert.equal(otelBoot.canvas.id, CANVAS_ID);

  // Verify cleanup of manager & telemetry if joinSession rejects during startup
  let failedCloseAllCalls = 0;
  let failedTelemetryShutdownCalls = 0;
  await assert.rejects(
    () =>
      startFactoryBoardExtension({
        CanvasError: MockCanvasError,
        createCanvas: (spec) => spec,
        env: {
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
          OTEL_EXPORTER_OTLP_HEADERS: "x-otlp-api-key=local-test-key",
        },
        startTelemetry: async () => ({
          observe: async (_stage, work) => work(),
          shutdown: async () => {
            failedTelemetryShutdownCalls += 1;
          },
        }),
        createManager: () => ({
          openInstance: async () => ({}),
          closeInstance: async () => true,
          closeAll: async () => {
            failedCloseAllCalls += 1;
          },
          refreshInstance: async () => null,
          setInstanceInterval: () => ({ ok: false, code: "instance_not_found", message: "none" }),
        }),
        joinSession: async () => {
          throw new Error("joinSession rejected");
        },
      }),
    /joinSession rejected/,
  );
  assert.equal(failedCloseAllCalls, 1);
  assert.equal(failedTelemetryShutdownCalls, 1);

  // Execute .github/extensions/factory-board/extension.mjs in a real Node subprocess with a stubbed @microsoft/copilot-sdk/extension module
  const loaderSource = `
    import { registerHooks } from "node:module";
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === "@microsoft/copilot-sdk/extension") {
          return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(
            "export class CanvasError extends Error { constructor(c,m){super(m);this.code=c;} }" +
            "export const createCanvas = (s) => s;" +
            "export const joinSession = async (o) => { await o.hooks.handlers.onSessionEnd(); process.stderr.write('EXT_JOINED:' + o.canvases.definitions[0].id); return { log(){} }; };"
          )};
        }
        return nextResolve(specifier, context);
      }
    });
  `;
  const loaderDataUrl = `data:text/javascript,${encodeURIComponent(loaderSource)}`;
  const extPath = join(process.cwd(), ".github", "extensions", "factory-board", "extension.mjs");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    "--import",
    loaderDataUrl,
    extPath,
  ]);
  assert.equal(stdout, "");
  assert.match(stderr, /EXT_JOINED:factory-board/);
});
