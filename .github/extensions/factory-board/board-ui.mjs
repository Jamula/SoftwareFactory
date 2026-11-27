import { createServer } from "node:http";
import {
  DEFAULT_INTERVAL_SECONDS,
  DEFAULT_REPO,
  createBoardPoller,
  fetchFactoryBoardSnapshot,
  parseRepoSlug,
  validateIntervalSeconds,
} from "../../../tools/engineering-factory/factory-board.mjs";

export const CANVAS_ID = "factory-board";
export const CANVAS_DISPLAY_NAME = "SoftwareFactory Live Board";
export const CANVAS_DESCRIPTION =
  "Live auto-refreshing milestone, issue, PR, CI, and merge-queue board for SoftwareFactory.";

const MAX_POST_BYTES = 4096;
const SSE_KEEPALIVE_MS = 15_000;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderBoardHtml({ title = CANVAS_DISPLAY_NAME, repo = DEFAULT_REPO } = {}) {
  const safeTitle = escapeHtml(title);
  const safeRepo = escapeHtml(repo);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
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

    * {
      box-sizing: border-box;
    }

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

    .title-group {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

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

    .meta-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      color: var(--board-muted);
      font-size: 12px;
    }

    .controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
    }

    button,
    select {
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
      transition: border-color 120ms ease, opacity 120ms ease;
    }

    button:hover,
    select:hover {
      border-color: var(--board-blue);
    }

    button:focus-visible,
    select:focus-visible,
    a:focus-visible,
    summary:focus-visible {
      outline: 2px solid var(--board-focus);
      outline-offset: 2px;
    }

    button.primary {
      background: var(--board-blue);
      border-color: var(--board-blue);
      color: var(--color-white, #ffffff);
    }

    button[disabled] {
      opacity: 0.6;
      cursor: default;
    }

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

    .pill.blue {
      background: var(--board-blue-soft);
      color: var(--board-blue);
      border-color: var(--board-blue);
    }

    .pill.red {
      background: var(--board-red-soft);
      color: var(--board-red);
      border-color: var(--board-red);
    }

    .pill.muted {
      color: var(--board-muted);
    }

    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--board-muted);
      display: inline-block;
    }

    .dot.live {
      background: var(--board-blue);
    }

    .dot.error {
      background: var(--board-red);
    }

    code,
    .mono {
      font-family: var(--font-mono, "SFMono-Regular", Consolas, "Liberation Mono", monospace);
      font-size: var(--text-code-inline, 12px);
    }

    .banner {
      border: 1px solid var(--board-red);
      background: var(--board-red-soft);
      color: var(--board-red);
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
    }

    .banner[hidden] {
      display: none;
    }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 10px;
    }

    .kpi-card {
      border: 1px solid var(--board-border);
      border-radius: 8px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .kpi-label {
      color: var(--board-muted);
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: var(--font-weight-semibold, 600);
    }

    .kpi-value {
      font-size: 20px;
      font-weight: var(--font-weight-semibold, 600);
      line-height: 24px;
    }

    .kpi-sub {
      color: var(--board-muted);
      font-size: 12px;
    }

    .section-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 8px;
    }

    h2 {
      margin: 0;
      font-size: 15px;
      font-weight: var(--font-weight-semibold, 600);
    }

    .milestones-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 12px;
    }

    .milestone-card {
      border: 1px solid var(--board-border);
      border-radius: 10px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    .milestone-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 8px;
    }

    .milestone-title {
      font-weight: var(--font-weight-semibold, 600);
      font-size: 14px;
    }

    .progress-track {
      width: 100%;
      height: 8px;
      border-radius: 999px;
      border: 1px solid var(--board-border);
      overflow: hidden;
      background: transparent;
    }

    .progress-fill {
      height: 100%;
      background: var(--board-blue);
      transition: width 200ms ease;
    }

    .chip-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    details.issue-drawer {
      border-top: 1px solid var(--board-border);
      padding-top: 8px;
    }

    details.issue-drawer summary {
      cursor: pointer;
      font-size: 12px;
      color: var(--board-muted);
      font-weight: var(--font-weight-semibold, 600);
      user-select: none;
    }

    .issue-list {
      list-style: none;
      margin: 8px 0 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .issue-item {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 6px 8px;
      border: 1px solid var(--board-border);
      border-radius: 6px;
      font-size: 12px;
    }

    .issue-main {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      flex: 1 1 200px;
    }

    .truncate {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    a {
      color: var(--board-blue);
      text-decoration: none;
    }

    a:hover {
      text-decoration: underline;
    }

    .filter-tabs {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .filter-tabs button.active {
      border-color: var(--board-blue);
      background: var(--board-blue-soft);
      color: var(--board-blue);
    }

    .table-wrap {
      border: 1px solid var(--board-border);
      border-radius: 10px;
      overflow-x: auto;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }

    th,
    td {
      text-align: left;
      padding: 10px 12px;
      border-bottom: 1px solid var(--board-border);
      vertical-align: middle;
    }

    th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--board-muted);
      font-weight: var(--font-weight-semibold, 600);
    }

    tr:last-child td {
      border-bottom: none;
    }

    .empty-state {
      padding: 18px;
      text-align: center;
      color: var(--board-muted);
      font-size: 13px;
    }
  </style>
</head>
<body>
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
        <span class="meta-row">Accepted (closed) issues are tracked separately from active open PRs</span>
      </div>
      <div class="milestones-grid" id="milestones-grid"></div>
    </section>

    <section aria-label="Open pull requests">
      <div class="section-header">
        <h2>Open Pull Requests &amp; Merge Queue</h2>
        <div class="filter-tabs" id="pr-filters">
          <button type="button" data-filter="all" class="active">All</button>
          <button type="button" data-filter="queue">Merge Queue</button>
          <button type="button" data-filter="fail">CI Failing</button>
          <button type="button" data-filter="pending">CI Pending</button>
          <button type="button" data-filter="pass">CI Passing</button>
        </div>
      </div>
      <div class="table-wrap" id="open-prs-wrap"></div>
    </section>

    <section aria-label="Recently merged pull requests">
      <div class="section-header">
        <h2>Recently Merged Pull Requests</h2>
      </div>
      <div class="table-wrap" id="merged-prs-wrap"></div>
    </section>
  </div>

  <script type="module">
    const state = {
      envelope: null,
      prFilter: "all",
      openDrawers: new Set(["M01", "M02"]),
      refreshing: false,
    };

    const el = (id) => document.getElementById(id);
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
      if (status === "CHANGES_REQUESTED") return '<span class="pill red">CHANGES REQ</span>';
      if (status === "REVIEW_REQUIRED") return '<span class="pill">REVIEW REQ</span>';
      if (status === "PENDING") return '<span class="pill muted">PENDING</span>';
      return '<span class="pill muted">UNKNOWN</span>';
    }

    function queueBadge(pr) {
      if (pr.mergeQueue && pr.mergeQueue.queued) {
        const pos = pr.mergeQueue.position !== null ? " #" + (pr.mergeQueue.position + 1) : "";
        return '<span class="pill blue">QUEUED' + pos + "</span>";
      }
      if (pr.isDraft) return '<span class="pill muted">DRAFT</span>';
      const ms = pr.mergeStateStatus || "UNKNOWN";
      const auto = pr.autoMerge ? " · AUTO" : "";
      if (ms === "DIRTY" || ms === "CONFLICTING") {
        return '<span class="pill red">' + esc(ms + auto) + "</span>";
      }
      if (ms === "CLEAN") {
        return '<span class="pill blue">' + esc(ms + auto) + "</span>";
      }
      return '<span class="pill muted">' + esc(ms + auto) + "</span>";
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
          const opt = document.createElement("option");
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
      if (!snap.ok && snap.error) {
        banner.hidden = false;
        banner.textContent =
          (snap.stale ? "Degraded (showing last verified snapshot) — " : "Snapshot unavailable — ") +
          snap.error.code +
          ": " +
          snap.error.message;
      } else {
        banner.hidden = true;
        banner.textContent = "";
      }

      const t = snap.totals;
      el("kpi-grid").innerHTML = [
        {
          label: "Accepted Issues",
          value: t.issuesClosed + " / " + t.issuesTotal,
          sub: t.completionPercent + "% closed across repo",
        },
        {
          label: "Active Milestones",
          value: t.milestonesOpen + " / " + snap.milestones.length,
          sub: "Roadmap v2 M01–M05",
        },
        {
          label: "Open Pull Requests",
          value: String(t.openPulls),
          sub: t.draftPulls + " draft · " + (t.openPulls - t.draftPulls) + " ready",
        },
        {
          label: "CI Check Health",
          value: t.ciPassingPulls + " pass",
          sub: t.ciPendingPulls + " pending · " + t.ciFailingPulls + " failing",
        },
        {
          label: "Review & Merge Queue",
          value: t.queuedPulls + " queued",
          sub: t.approvedPulls + " approved open PRs",
        },
        {
          label: "Recent Merges",
          value: String(t.mergedRecentPulls),
          sub: "Latest merged PR window",
        },
      ]
        .map(
          (k) =>
            '<div class="kpi-card">' +
            '<span class="kpi-label">' + esc(k.label) + "</span>" +
            '<span class="kpi-value">' + esc(k.value) + "</span>" +
            '<span class="kpi-sub">' + esc(k.sub) + "</span>" +
            "</div>",
        )
        .join("");

      el("milestones-grid").innerHTML = snap.milestones
        .map((m) => {
          const isOpen = state.openDrawers.has(m.id);
          const issuesHtml =
            m.issues.length === 0
              ? '<div class="empty-state">No issues assigned</div>'
              : '<ul class="issue-list">' +
                m.issues
                  .map((iss) => {
                    const prLinks = (iss.linkedPullNumbers || [])
                      .map((num) => '<span class="pill blue mono">PR #' + num + "</span>")
                      .join(" ");
                    const prio = iss.priority
                      ? '<span class="pill' + (iss.priority === "P0" ? " red" : " muted") + '">' + esc(iss.priority) + "</span>"
                      : "";
                    const step = iss.stepId
                      ? '<span class="pill mono muted">' + esc(iss.stepId) + "</span>"
                      : "";
                    const stBadge =
                      iss.state === "CLOSED"
                        ? '<span class="pill blue">CLOSED</span>'
                        : '<span class="pill muted">OPEN</span>';
                    return (
                      '<li class="issue-item">' +
                      '<div class="issue-main">' +
                      stBadge +
                      step +
                      prio +
                      '<a class="truncate" href="' + safeHref(iss.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(iss.title) + '">' +
                      '<span class="mono">#' + iss.number + "</span> " + esc(iss.title) +
                      "</a>" +
                      "</div>" +
                      '<div class="chip-row">' + prLinks + "</div>" +
                      "</li>"
                    );
                  })
                  .join("") +
                "</ul>";

          return (
            '<article class="milestone-card">' +
            '<div class="milestone-top">' +
            '<div><div class="milestone-title">' + esc(m.title) + "</div>" +
            '<div class="meta-row">' + esc(m.closedIssues + " closed · " + m.openIssues + " open") + "</div></div>" +
            '<span class="pill ' + (m.completionPercent === 100 && m.totalIssues > 0 ? "blue" : "muted") + '">' +
            m.completionPercent + "%</span>" +
            "</div>" +
            '<div class="progress-track" role="progressbar" aria-valuenow="' + m.completionPercent + '" aria-valuemin="0" aria-valuemax="100">' +
            '<div class="progress-fill" style="width:' + m.completionPercent + '%"></div>' +
            "</div>" +
            '<div class="chip-row">' +
            '<span class="pill' + (m.activePulls > 0 ? " blue" : " muted") + '">' + m.activePulls + " open PR" + (m.activePulls === 1 ? "" : "s") + "</span>" +
            (m.ciPassingPulls > 0 ? '<span class="pill blue">' + m.ciPassingPulls + " CI pass</span>" : "") +
            (m.ciPendingPulls > 0 ? '<span class="pill">' + m.ciPendingPulls + " CI pending</span>" : "") +
            (m.ciFailingPulls > 0 ? '<span class="pill red">' + m.ciFailingPulls + " CI fail</span>" : "") +
            (m.queuedPulls > 0 ? '<span class="pill blue">' + m.queuedPulls + " queued</span>" : "") +
            "</div>" +
            '<details class="issue-drawer" data-ms="' + esc(m.id) + '"' + (isOpen ? " open" : "") + ">" +
            "<summary>Issues (" + m.issues.length + ")</summary>" +
            issuesHtml +
            "</details>" +
            "</article>"
          );
        })
        .join("");

      el("milestones-grid")
        .querySelectorAll("details.issue-drawer")
        .forEach((d) => {
          d.addEventListener("toggle", () => {
            const id = d.getAttribute("data-ms");
            if (d.open) state.openDrawers.add(id);
            else state.openDrawers.delete(id);
          });
        });

      const filteredPrs = snap.openPulls.filter((pr) => {
        if (state.prFilter === "queue") return pr.mergeQueue && pr.mergeQueue.queued;
        if (state.prFilter === "fail") return pr.ci.state === "FAIL";
        if (state.prFilter === "pending") return pr.ci.state === "PENDING";
        if (state.prFilter === "pass") return pr.ci.state === "PASS";
        return true;
      });

      el("open-prs-wrap").innerHTML =
        filteredPrs.length === 0
          ? '<div class="empty-state">No open pull requests match the current filter.</div>'
          : "<table><thead><tr>" +
            "<th>PR</th><th>Milestone</th><th>Branch</th><th>CI Checks</th><th>Review</th><th>Merge / Queue</th>" +
            "</tr></thead><tbody>" +
            filteredPrs
              .map(
                (pr) =>
                  "<tr>" +
                  '<td><a href="' + safeHref(pr.url) + '" target="_blank" rel="noopener noreferrer"><span class="mono">#' + pr.number + "</span> " + esc(pr.title) + "</a></td>" +
                  "<td>" + (pr.milestoneId ? '<span class="pill mono">' + esc(pr.milestoneId) + "</span>" : '<span class="pill muted">—</span>') + "</td>" +
                  '<td><code>' + esc(pr.headRefName || "—") + "</code></td>" +
                  "<td>" + ciBadge(pr.ci) + "</td>" +
                  "<td>" + reviewBadge(pr.reviewStatus) + "</td>" +
                  "<td>" + queueBadge(pr) + "</td>" +
                  "</tr>",
              )
              .join("") +
            "</tbody></table>";

      el("merged-prs-wrap").innerHTML =
        snap.mergedPulls.length === 0
          ? '<div class="empty-state">No recently merged pull requests.</div>'
          : "<table><thead><tr>" +
            "<th>PR</th><th>Milestone</th><th>Branch</th><th>Merged At</th>" +
            "</tr></thead><tbody>" +
            snap.mergedPulls
              .map(
                (pr) =>
                  "<tr>" +
                  '<td><a href="' + safeHref(pr.url) + '" target="_blank" rel="noopener noreferrer"><span class="mono">#' + pr.number + "</span> " + esc(pr.title) + "</a></td>" +
                  "<td>" + (pr.milestoneId ? '<span class="pill mono">' + esc(pr.milestoneId) + "</span>" : '<span class="pill muted">—</span>') + "</td>" +
                  '<td><code>' + esc(pr.headRefName || "—") + "</code></td>" +
                  '<td class="mono">' + esc(fmtTime(pr.mergedAt)) + "</td>" +
                  "</tr>",
              )
              .join("") +
            "</tbody></table>";
    }

    async function postJson(path, body) {
      const res = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      if (res.ok) {
        state.envelope = await res.json();
        render();
      }
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

    el("pr-filters").addEventListener("click", (ev) => {
      const btn = ev.target.closest("button[data-filter]");
      if (!btn) return;
      state.prFilter = btn.getAttribute("data-filter");
      el("pr-filters").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });

    const source = new EventSource("/events");
    source.addEventListener("open", () => setSseState("live", "Live SSE"));
    source.addEventListener("error", () => setSseState("error", "Reconnecting…"));
    source.addEventListener("state", (ev) => {
      try {
        state.envelope = JSON.parse(ev.data);
        setSseState("live", "Live SSE");
        render();
      } catch {
        setSseState("error", "Stream parse error");
      }
    });

    fetch("/api/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (data && !state.envelope) {
          state.envelope = data;
          render();
        }
      })
      .catch(() => {});
  </script>
</body>
</html>`;
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

export async function startLoopbackBoardServer({
  repo = DEFAULT_REPO,
  intervalSeconds = DEFAULT_INTERVAL_SECONDS,
  fetchSnapshot = fetchFactoryBoardSnapshot,
  timers,
  onLog,
} = {}) {
  const poller = createBoardPoller({
    repo,
    intervalSeconds,
    fetchSnapshot,
    ...(timers ? { timers } : {}),
  });

  const sockets = new Set();
  const sseClients = new Map();
  const html = renderBoardHtml({ title: CANVAS_DISPLAY_NAME, repo: parseRepoSlug(repo).fullName });

  const unsubscribe = poller.subscribe((envelope) => {
    const frame = `event: state\ndata: ${JSON.stringify(envelope)}\n\n`;
    for (const res of sseClients.keys()) {
      if (!res.writableEnded) {
        res.write(frame);
      }
    }
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const method = req.method ?? "GET";

      if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(html);
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

      if (method === "POST" && pathname === "/api/refresh") {
        await readBoundedBody(req);
        const refreshed = await poller.refresh();
        sendJson(res, 200, refreshed);
        return;
      }

      if (method === "POST" && pathname === "/api/control") {
        const body = await readBoundedBody(req);
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

        const keepAlive = setInterval(() => {
          if (!res.writableEnded) {
            res.write(": keepalive\n\n");
          }
        }, SSE_KEEPALIVE_MS);
        keepAlive.unref?.();

        sseClients.set(res, keepAlive);
        res.write(`event: state\ndata: ${JSON.stringify(poller.getState())}\n\n`);
        if (!poller.getState().snapshot) {
          void poller.refresh();
        }

        const cleanupClient = () => {
          const timer = sseClients.get(res);
          if (timer) {
            clearInterval(timer);
            sseClients.delete(res);
          }
        };
        req.on("close", cleanupClient);
        res.on("close", cleanupClient);
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
  const url = `http://127.0.0.1:${port}/`;

  void poller.start();

  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    unsubscribe();
    poller.close();
    for (const [res, timer] of sseClients.entries()) {
      clearInterval(timer);
      if (!res.writableEnded) {
        res.end();
      }
    }
    sseClients.clear();
    await new Promise((resolve) => {
      server.close(() => resolve());
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    });
  }

  return {
    url,
    port,
    poller,
    close,
  };
}

export function createBoardInstanceManager({
  fetchSnapshot = fetchFactoryBoardSnapshot,
  timers,
  onLog,
} = {}) {
  const instances = new Map();

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
    const requestedRepo = ctx?.input?.repo ?? DEFAULT_REPO;

    let entry = instances.get(instanceId);
    if (!entry) {
      entry = await startLoopbackBoardServer({
        repo: requestedRepo,
        intervalSeconds: requestedInterval ?? DEFAULT_INTERVAL_SECONDS,
        fetchSnapshot,
        timers,
        onLog,
      });
      instances.set(instanceId, entry);
    } else if (requestedInterval !== undefined) {
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
    const entry = instances.get(instanceId);
    if (!entry) {
      return false;
    }
    instances.delete(instanceId);
    await entry.close();
    return true;
  }

  async function closeAll() {
    const closing = [...instances.keys()].map((id) => closeInstance(id));
    await Promise.all(closing);
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
