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
  createBoardPoller,
  extractMilestoneStep,
  fetchFactoryBoardSnapshot,
  fetchViaGhGraphql,
  fetchViaPublicRest,
  formatBoardStatus,
  inferIssueMilestoneId,
  inferPullMilestoneId,
  normalizeCheckRollup,
  normalizeMergeQueue,
  normalizeReviewStatus,
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

test("normalizeCheckRollup, normalizeReviewStatus, and normalizeMergeQueue fail closed on missing or mixed states", () => {
  assert.deepEqual(normalizeCheckRollup(null), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "SUCCESS", contexts: [] }), {
    state: "PASS",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "FAILURE" }), {
    state: "FAIL",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "ERROR" }), {
    state: "FAIL",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "PENDING" }), {
    state: "PENDING",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({ state: "EXPECTED" }), {
    state: "PENDING",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({}), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
  });
  assert.deepEqual(normalizeCheckRollup({ contexts: [null, { unknownField: 1 }] }), {
    state: "UNKNOWN",
    total: 0,
    passed: 0,
    failed: 0,
    pending: 0,
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
    { state: "PASS", total: 4, passed: 4, failed: 0, pending: 0 },
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
    { state: "PENDING", total: 4, passed: 1, failed: 0, pending: 3 },
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
    { state: "FAIL", total: 4, passed: 0, failed: 3, pending: 1 },
  );

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
    "APPROVED",
  );

  assert.deepEqual(normalizeMergeQueue(null), { queued: false, state: null, position: null });
  assert.deepEqual(normalizeMergeQueue({ state: "AWAITING_CHECKS", position: 0 }), {
    queued: true,
    state: "AWAITING_CHECKS",
    position: 0,
  });
  assert.deepEqual(normalizeMergeQueue({ state: "", position: -1 }), {
    queued: true,
    state: "QUEUED",
    position: null,
  });
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
        mergeQueueEntry: { state: "QUEUED", position: 0 },
        closingIssuesReferences: [{ number: 5 }, { number: 0 }],
        checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "SUCCESS" }] },
      },
      {
        number: 128,
        title: "Add scorecard (#18)",
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
        checkRollup: { contexts: [{ status: "COMPLETED", conclusion: "FAILURE" }] },
      },
      {
        number: 141,
        title: "Unchecked chore PR",
        isDraft: false,
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
        closingIssuesReferences: [{ number: 18 }],
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
  assert.equal(m02.activePulls, 1);
  assert.equal(m02.ciPendingPulls, 1);

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
  assert.equal(coldUnavailable.stale, false);
  assert.equal(coldUnavailable.source, "unavailable");
  assert.equal(coldUnavailable.totals.completionPercent, 0);
  assert.equal(coldUnavailable.error.code, "SNAPSHOT_UNAVAILABLE");

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
          nodes: [{ number: 2, title: "M01 - Autonomous SoftwareFactory", state: "OPEN" }],
        },
        openIssues: {
          nodes: [
            null,
            {
              number: 4,
              title: "[M01.01 P0] Exact-head quality",
              state: "OPEN",
              url: "https://github.com/Jamula/SoftwareFactory/issues/4",
              updatedAt: "2026-11-27T00:00:00Z",
              labels: { nodes: [{ name: "M01" }, null] },
              milestone: { title: "M01 - Autonomous SoftwareFactory" },
            },
          ],
        },
        closedIssues: {
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

  const ghSnap = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:00:00Z",
    execGh: async (args) => {
      assert.equal(args[0], "api");
      assert.equal(args[1], "graphql");
      return JSON.stringify(graphqlPayload);
    },
    request: async () => {
      throw new Error("should not hit REST when gh succeeds");
    },
  });
  assert.equal(ghSnap.ok, true);
  assert.equal(ghSnap.source, "gh-graphql");
  assert.equal(ghSnap.totals.openPulls, 2);

  // Sparse GraphQL repository object (missing optional arrays)
  const sparseRaw = await fetchViaGhGraphql({
    owner: "Jamula",
    name: "SoftwareFactory",
    execGh: async () => JSON.stringify({ data: { repository: { openPulls: { nodes: [{ number: 1, title: "T", commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS", contexts: null } } }] } }] } } } }),
  });
  assert.equal(sparseRaw.openPulls.length, 1);

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

  // Fallback to public REST when gh fails
  const restRequest = async (url) => {
    if (url.includes("/milestones?")) {
      return new Response(
        JSON.stringify([{ number: 6, title: "M02 - Fast SoftwareFactory", state: "open" }]),
      );
    }
    if (url.includes("/issues?")) {
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
            title: "Unlabeled issue",
            state: "open",
            labels: null,
            milestone: null,
          },
          {
            number: 128,
            title: "PR disguised in /issues",
            state: "open",
            pull_request: { url: "https://api.github.com/..." },
          },
        ]),
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
          check_runs: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      );
    }
    if (url.includes("/pulls/128/reviews")) {
      return new Response(JSON.stringify([{ user: { login: "rev1" }, state: "APPROVED" }]));
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
  assert.equal(fallbackSnap.openPulls[0].reviewStatus, "APPROVED");
  assert.equal(fallbackSnap.openPulls[1].ci.state, "UNKNOWN");
  assert.equal(fallbackSnap.openPulls[1].reviewStatus, "UNKNOWN");

  await assert.rejects(
    () =>
      fetchViaPublicRest({
        owner: "Jamula",
        name: "SoftwareFactory",
        request: async () => new Response(JSON.stringify({ notArray: true })),
      }),
    /REST_PAYLOAD_INVALID/,
  );

  // Invalid repo slug fails closed
  const badSlugSnap = await fetchFactoryBoardSnapshot({
    repo: "invalid slug",
    clock: () => "2026-11-27T01:12:00Z",
  });
  assert.equal(badSlugSnap.ok, false);
  assert.equal(badSlugSnap.error.code, "INVALID_REPO_SLUG");

  // Both gh and REST failing preserves previousSnapshot with stale: true
  const bothFailed = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    clock: () => "2026-11-27T01:15:00Z",
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

  // Exercise defaultExecGh error path with non-existent command or failing gh call
  const realFallback = await fetchFactoryBoardSnapshot({
    repo: DEFAULT_REPO,
    timeoutMs: 1,
    request: async () => {
      throw new Error("offline");
    },
  });
  assert.equal(realFallback.ok, false);
  assert.equal(realFallback.error.code, "SNAPSHOT_FETCH_FAILED");
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

  // Idempotent reopen returns same server URL and honors updated interval
  const reopened = await spec.open({
    canvasId: "factory-board",
    instanceId: "inst-1",
    input: { intervalSeconds: 25 },
  });
  assert.equal(reopened.url, opened.url);
  assert.equal(reopened.status, "Auto-refreshing (25s)");

  // Connect live SSE viewer to /events
  const sseAbort = new AbortController();
  const sseRes = await fetch(`${opened.url}events`, { signal: sseAbort.signal });
  assert.equal(sseRes.status, 200);
  assert.match(sseRes.headers.get("content-type") ?? "", /text\/event-stream/);
  const sseReader = sseRes.body.getReader();
  const sseDecoder = new TextDecoder();
  const firstChunk = await sseReader.read();
  assert.match(sseDecoder.decode(firstChunk.value), /event: state/);

  // Test HTTP GET /, GET /api/state, POST /api/refresh, POST /api/control, and error routes
  const htmlRes = await fetch(opened.url);
  assert.equal(htmlRes.status, 200);
  assert.match(await htmlRes.text(), /SoftwareFactory Live Board/);

  const stateRes = await fetch(`${opened.url}api/state`);
  assert.equal(stateRes.status, 200);
  const stateJson = await stateRes.json();
  assert.equal(stateJson.snapshot.totals.openPulls, 1);

  const postRefreshRes = await fetch(`${opened.url}api/refresh`, { method: "POST" });
  assert.equal(postRefreshRes.status, 200);

  // Read pushed SSE update triggered by /api/refresh
  const secondChunk = await sseReader.read();
  assert.match(sseDecoder.decode(secondChunk.value), /event: state/);

  const pauseRes = await fetch(`${opened.url}api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paused: true, intervalSeconds: 30 }),
  });
  assert.equal(pauseRes.status, 200);
  const pauseJson = await pauseRes.json();
  assert.equal(pauseJson.config.paused, true);
  assert.equal(pauseJson.config.status, "Paused");

  const badIntervalHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    body: JSON.stringify({ intervalSeconds: 2 }),
  });
  assert.equal(badIntervalHttp.status, 400);

  const badJsonHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    body: "{broken",
  });
  assert.equal(badJsonHttp.status, 400);

  const arrayJsonHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
    body: "[]",
  });
  assert.equal(arrayJsonHttp.status, 400);

  const tooLargeHttp = await fetch(`${opened.url}api/control`, {
    method: "POST",
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

  // Direct startLoopbackBoardServer double-close idempotency
  const standalone = await startLoopbackBoardServer({ fetchSnapshot: fakeFetchSnapshot });
  await standalone.close();
  await standalone.close();
  assert.ok(logs.length >= 1);
});
