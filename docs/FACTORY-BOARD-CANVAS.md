# SoftwareFactory Live Board Canvas

Project-scoped Copilot CLI Extension Canvas providing a live, auto-refreshing, read-only view of `Jamula/SoftwareFactory` roadmap milestones (`M01`–`M05`), open/closed issues, active pull requests (CI check rollups, review status, merge-queue state), and recently merged pull requests.

## Layout and file ownership

| File | Responsibility |
| --- | --- |
| `.github/extensions/factory-board/extension.mjs` | Copilot CLI extension entrypoint registering canvas `factory-board` via `@microsoft/copilot-sdk/extension`. |
| `.github/extensions/factory-board/board-ui.mjs` | Ephemeral loopback (`127.0.0.1:0`) HTTP + Server-Sent Events (`/events`) server and Copilot App themed HTML/CSS/JS renderer. |
| `tools/engineering-factory/factory-board.mjs` | Pure/injectable GitHub metadata fetcher (`gh` GraphQL with bounded public REST fallback), snapshot normalizer, and polling state coordinator. |
| `tests/engineering-factory/factory-board.test.mjs` | Headless `node:test` replay and loopback integration suite (`>=98%` line and `>=95%` branch coverage). |

Do not add a `package.json` or `node_modules` directory under `.github/extensions/factory-board/`; the Copilot CLI resolves `@microsoft/copilot-sdk/extension` automatically and reserves `stdout` for JSON-RPC over stdio.

## Opening in GitHub Copilot App / Copilot CLI

Because `.github/extensions/factory-board/extension.mjs` lives under `.github/extensions/`, Copilot CLI discovers it automatically as `project:factory-board`:

1. Ask Copilot to open the `factory-board` canvas (for example: *"Open the SoftwareFactory Live Board canvas"*), or invoke `open_canvas({ canvasId: "factory-board", instanceId: "board-1" })`.
2. Optional `open` input parameters:
   - `repo`: `"owner/name"` (defaults to `"Jamula/SoftwareFactory"`).
   - `intervalSeconds`: integer from `10` to `300` (defaults to `20`).
3. Supported agent-callable canvas actions on an open `instanceId`:
   - `refresh`: Immediately refreshes live GitHub metadata, broadcasts the updated snapshot over SSE to connected viewers, and returns the raw milestone/PR summary.
   - `set_interval`: Accepts `{ "intervalSeconds": <10..300> }` to reschedule background auto-refresh; throws `CanvasError("invalid_interval", ...)` if out of bounds.
4. Interactive controls inside the canvas panel:
   - **Refresh now** (`POST /api/refresh`) for an immediate snapshot pull.
   - **Pause / Resume auto-refresh** (`POST /api/control`) and **Interval selector** (`10s`–`300s`).
   - **PR filter tabs** (`All`, `Merge Queue`, `CI Failing`, `CI Pending`, `CI Passing`) and expandable per-milestone issue drawers preserved across live SSE updates.

## Local standalone preview

To preview the loopback board in a local browser outside a Copilot Canvas host session, start `startLoopbackBoardServer` directly with Node.js:

```bash
node -e '
import("./.github/extensions/factory-board/board-ui.mjs").then(async ({ startLoopbackBoardServer }) => {
  const srv = await startLoopbackBoardServer();
  process.stderr.write("Factory Board listening at " + srv.url + "\n");
});
'
```

Press `Ctrl+C` to stop the preview process.

## Safety, telemetry, and governance boundaries

- **Read-only and metadata-only**: Reads milestone, issue, PR, check-run, review, and merge-queue metadata via `gh api graphql` (`GH_PAGER=""`) when authenticated locally, falling back automatically to bounded `GET` requests against `https://api.github.com/repos/Jamula/SoftwareFactory/...` (`AbortSignal.timeout(5000)`, `redirect: "error"`, 1 MiB response cap).
- **Fail-closed**: Missing check/review data reports `UNKNOWN` rather than `PASS`. Total read failures mark `ok: false` with explicit error codes (`stale: true` if preserving the last verified snapshot) and never fabricate progress.
- **Strict acceptance accounting**: Accepted (`CLOSED`) issues and active (`OPEN`) pull requests are reported separately per [engineering standards](ENGINEERING-STANDARDS.md). GitHub Issues and PRs remain authoritative; the canvas does not persist a competing backlog or authorize dispatch/merge actions.
