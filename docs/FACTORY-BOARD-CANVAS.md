# SoftwareFactory Live Board Canvas

Project-scoped Copilot CLI Extension Canvas providing a live, auto-refreshing, read-only view of `Jamula/SoftwareFactory` roadmap milestones (`M01`–`M05`), open/closed issues, active pull requests (CI check rollups, review status, merge-queue state), and recently merged pull requests.

## Layout and file ownership

| File | Responsibility |
| --- | --- |
| `.github/extensions/factory-board/extension.mjs` | Copilot CLI extension entrypoint registering canvas `factory-board` via `@microsoft/copilot-sdk/extension`. |
| `.github/extensions/factory-board/board-ui.mjs` | Declarative extension UI re-export binding the loopback HTTP/SSE server, themed renderer, and canvas specification from `tools/engineering-factory/factory-board.mjs`. |
| `tools/engineering-factory/factory-board.mjs` | Instrumented, coverage-enforced GitHub metadata fetcher (`gh` GraphQL + bounded paginated REST fallback), snapshot normalizer, polling coordinator, loopback HTTP/SSE server, and browser UI controller (`initFactoryBoardClient`). |
| `tests/engineering-factory/factory-board.test.mjs` | Headless `node:test` replay, browser controller, and loopback integration suite (`>=98%` line and `>=95%` branch coverage). |

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

- **Read-only and metadata-only**: Reads milestone, issue, PR, check-run, commit-status, review, and merge-queue metadata via bounded paginated `gh api --hostname github.com graphql` (`GH_HOST=github.com`, `GH_PAGER=""`) when authenticated locally, falling back automatically to rate-limit-aware bounded paginated `GET` requests against `https://api.github.com/repos/Jamula/SoftwareFactory/...` (`AbortSignal.timeout(5000)`, `redirect: "error"`, 1 MiB response cap, honoring `x-ratelimit-remaining`/`x-ratelimit-reset`/`retry-after` headers without adding credentials). Emits sanitized `"reconcile"` stage telemetry observations (`eligible` / `blocked` / `failed`) through the local-only OpenTelemetry bootstrap (`local-otel-sdk.mjs`) when configured, keeping headless operation independent and remote export disabled.
- **Cross-repository isolation**: Only issue references targeting the board's own repository (`#N`, `owner/repo#N`, or GraphQL `closingIssuesReferences` matching `nameWithOwner`) are correlated to local issues and milestones.
- **Loopback authority, capability protection, and bounded SSE streaming**: Validates the exact bound `127.0.0.1:<port>` `Host` authority on every route, rejects cross-origin/cross-site requests, requires `Content-Type: application/json` plus a per-instance cryptographic `X-Factory-Board-Token` capability header on `POST` control routes, and coalesces backpressured `/events` SSE updates to a single pending state frame with a 256 KiB buffer cap for slow viewers.
- **Fail-closed and completeness-aware**: Truncated or partially unavailable check/status/review reads report `UNKNOWN` unless a failure is established, and REST snapshots report `queuedPulls: null` (`Queue unknown` / `QUEUE UNKNOWN`) rather than fabricating `0 queued`. Repository inventories exceeding pagination caps mark `partial: true` (`completionPercent: null`) rather than presenting sampled subsets as complete totals. Cold-start failures keep aggregates `null`/unavailable rather than fabricating zero counts, and only `verified: true` snapshots are preserved as `stale: true` across subsequent failures.
- **Activity proxy vs. verified acceptance**: Closed (`CLOSED`) issues and active (`OPEN`) pull requests are labeled and reported separately as GitHub activity proxies rather than verified acceptance outcomes per [engineering standards](ENGINEERING-STANDARDS.md). GitHub Issues and PRs remain authoritative; the canvas does not persist a competing backlog or authorize dispatch/merge actions.
