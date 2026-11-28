# Repository guidance

- Keep all evaluators deterministic, metadata-only, read-only, and fail-closed.
- Never execute code from a consumer pull request in a privileged workflow.
- Do not add credentials, live dispatch/merge operations, approval generation,
  deployments, or paid services without separate owner approval.
- Treat example policies and identities as synthetic; do not add project data.
- Preserve per-consumer security, review, coverage, ownership, budget, and
  release requirements. Repository names do not grant authorization.
- Keep source provenance and Apache-2.0 notices when adapting upstream material.
- Validate changes locally before pushing:
  - `npm ci --ignore-scripts && npm run test:coverage` (Node.js `26.13.1`, `70+` `.mjs` components across `tools/engineering-factory/` and `tools/engineering-coordinator/` at `>=98%` lines / `>=95%` branches)
  - `dotnet test tests/SoftwareFactory.Agents.Tests/SoftwareFactory.Agents.Tests.csproj --configuration Release` (`.NET SDK 10.0.404` + Microsoft Agent Framework `1.28.0` GA, `18` xUnit tests; `-p:CollectCoverage=true` enforces Coverlet `98%/95%`)
  - `node tools/engineering-factory/run.mjs --smoke` (clean temporary `.local`, `coverage-evidence.json`, and `cobertura-coverage.xml` before committing)

## Delivery rules & Chronicle retrospective invariants

Follow [engineering standards](docs/ENGINEERING-STANDARDS.md) and [contributing](CONTRIBUTING.md):

1. **Fail closed in 10 lines over 300-line partial-recovery heuristics**: reject missing, malformed, proxy/getter, or stale evidence immediately with a deterministic reason code rather than adding partial-recovery heuristics that cause multi-round review spirals.
2. **Never commit literal secret-like strings in tests or fixtures**: never include literal `ghp_`..., `github_pat_`..., `sk-`..., or `AKIA`... strings; construct secret-scanner test inputs via runtime string concatenation so GitHub Secret Scanning never blocks Merge Queue.
3. **Strict non-overlapping file-ownership lanes**: reuse issues and PRs, enforce one independent owner per lane (`0` concurrent owners on shared barrel/lock files, never touch SHA-256 hash-locked `.github/workflows/factory-orchestrator.md` ↔ `.lock.yml` outside dedicated workflow lanes), and batch `<= 3` concurrent `git worktree add` operations to avoid `.git/config.lock` races.
4. **Preserve provenance, exact-head independent review, and `$0` spend**: preserve Apache-2.0 notices, record exact-head tests and covered/total line and branch counts (`>=98%/95%` per component and overall for SoftwareFactory; `>=95%/90%` or stricter consumer gates), satisfy `Default-Branch-Ruleset` `28054442` (`review_on_push: false` + GitHub Native Squash Merge Queue `ALLGREEN`) and summary-only review disposition, keep partial acceptance issues open, and enforce `#105` `$0` overage hard-stops. Speed objectives never authorize bypassing security, budget, permissions, review, or release gates.

## Platform standard

Use **Aspire `17.0.0` AppHost** (`apphost.cs`) for local orchestration and hosted synthetic verification (`synthetic-shadow` Node `26.13.1` + `maf-specialist-shadow` `.NET 10.0.404`), exporting OpenTelemetry traces, metrics, and correlated structured logs via authenticated loopback OTLP only ([#17](https://github.com/Jamula/SoftwareFactory/issues/17), [#118](https://github.com/Jamula/SoftwareFactory/issues/118), [#9](https://github.com/Jamula/SoftwareFactory/issues/9)). Zero tracked Python files or workflow Python invocations (`no-python-guard.mjs`); no retired July 2026 GitHub Models packages. Preserve pure evaluator behavior and headless tests. No real provider calls, private data, external telemetry, secrets, or paid hosting. Follow [local development](docs/LOCAL-DEVELOPMENT.md). Prioritize SoftwareFactory with verified available included capacity; do not dispatch when budget is unknown or estimated.

## Roadmap v2 and consumer rollout order

Follow [roadmap v2](docs/ROADMAP.md):
- **`M01`**: Autonomous SoftwareFactory (`github/gh-aw` `v1.2.2+` `.lock.yml` + `safe-outputs` + `tools.work-queue` non-force git-ref CAS on `refs/heads/work-queue` + native `copilot-swe-agent[bot]` + Squash Merge Queue) — `9 / 10` foundation issues closed (`#4–#9, #17, #105, #118`); `#10` live 3-issue `@copilot` proof active.
- **`M02`**: Fast SoftwareFactory (`.NET 10.0.404` + Microsoft Agent Framework `1.28.0` GA in `src/SoftwareFactory.Agents/`, superseding the earlier optional Rust execution-engine experiment; poison-safe exact-lockfile CI caching `#15`/`#174`; `factory-board` live Canvas `#135`; 9-link W3C `traceparent` anti-rogue audit & Kaizen loop `#137`; deferred MCP multi-agent connector `#136`).
- **`M03` → `M04` → `M05` consumers**: **`M03`** shared onboarding contract (`#13`, closed) + Consumer #1 `Jamula/Spellbook` (`#11`, `M03.02 P0`, `>=97%/90%`, WebKit/iOS/release gates, 2-agent cap) → **`M04`** Consumer #2 `Jamula/FamilyTree` (`#36`, `M04.01 P1`, `>=95%/90%`, genealogy private-data isolation) → **`M05`** Consumer #3 `FamilyHub` (`#12`, `M05.01 P1`, migration-freeze gate, formal exact-head `APPROVED`, strict base freshness, production isolation).

GitHub is the orchestrator and supported GitHub-hosted execution is required. Do not depend on a personal laptop, open chat, or always-on local process. Ephemeral runner storage is not an authoritative cross-run lease store. Respect all separate live authorization and `$0`-spend gates.
