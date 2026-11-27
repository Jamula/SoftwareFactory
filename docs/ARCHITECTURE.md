# Architecture (0.1.0)

## Current module boundaries

Executable production JavaScript lives in two ESM packages under `tools/` (`tools/engineering-factory/*.mjs` and `tools/engineering-coordinator/*.mjs`), tested on Node.js `26.13.1` with >=98% source line coverage and >=95% branch coverage enforced per `.mjs` component and overall by `tests/engineering-factory/coverage-reporter.mjs`. Every evaluator and shadow adapter is deterministic, fail-closed, and non-mutating (`shadow: true`, `liveMerge: false` / `liveDispatch: false`).

### `tools/engineering-factory/` — policy evaluators, metadata adapters, and telemetry boundary

- **Pure policy, coverage, review, and merge-gate evaluators** (zero I/O, rejecting sparse arrays and stale heads; receipt/boundary verifiers such as `coverage-evidence.mjs`, `platform-merge-gates.mjs`, `protected-squash.mjs`, and `queue-reread.mjs` inspect own data descriptors to reject proxies, getters, and custom prototypes, whereas `core.mjs`, `review-history.mjs`, `review-batch.mjs`, and remaining snapshot evaluators require callers to supply trusted, normalized plain JSON data):
  - `core.mjs`: validates closed version-1 repository policies (`validPolicy`) and normalized plain-JSON snapshots (`evaluate`—checking own-key presence rather than property descriptors, so adapters or `protected-squash.mjs` must strip getters/proxies upstream), returning frozen `{ state, reason, shadow: true }` decisions. `policySource: "trusted-default-branch"` and snapshot fields are caller assertions, not proof of live authority.
  - `coverage-evidence.mjs`: validates exact-head component and aggregate line/branch counts (`coverageEvidence`, `coverageFromNodeSummary`) against SoftwareFactory's 98/95 floor or consumer `>=95/90` (and stricter existing consumer floors such as `97/90` without lowering gates), enforces exact-head reviewed justifications for any branchless (`0/0`) component without fabricating `100%`, and reconciles effective `main` ruleset, fork-PR, `merge_group`, `CodeQL`, summary-finding, and `minimum_coverage >= 98` gates (`verifyCandidateGateReceipt`).
  - `review-history.mjs` and `review-batch.mjs`: normalize chronological review sequences (permitting exact-head allowlisted `copilot-pull-request-reviewer[bot]` `COMMENTED` reviews with `summaryDisposition: "clear"` only for `Jamula/SoftwareFactory` when unblocked, while requiring formal `APPROVED` for consumers) and batch actionable inline and summary-only findings.
  - `platform-merge-gates.mjs`, `protected-squash.mjs`, `integration-train.mjs`, `queue-inspection.mjs`, and `queue-reread.mjs`: compose candidate platform checks, serialized shadow squash state machines with post-merge `main` health verification, inert GraphQL `enqueuePullRequest` (`expectedHeadOid`, `jump: false`) request builders, queue diagnostics, and matched integration-train comparisons.
  - `budget.mjs`, `capacity-scale.mjs`, `contract-routing.mjs`, `dispatch-intent.mjs`, `lease-transition.mjs`, `locked-build-cache.mjs`, `pilot-readiness.mjs`, `pr-iterations.mjs`, `pr-lifecycle.mjs`, `stage-latency.mjs`, `stage-aggregate.mjs`, `outcome-measurement.mjs`, and `validation-diagnosis.mjs`: pure evaluators for zero-overage budget allocation, staged worker scaling, knowledge/specialist routing, fast-feedback/build-reuse validation, lifecycle/queue diagnostics, and p50/p95 cohort outcome measurement.
- **Read-only GitHub metadata adapters and shadow CLI** (bounded unauthenticated reads, no write credentials):
  - `run.mjs`, `shadow-runtime.mjs`, `event-envelope.mjs`, `issue-event.mjs`, `pull-signals.mjs`, `shadow-dispatch-ledger.mjs`, and `local-shadow-host.mjs`: provide the CLI (`--smoke`, `--inventory`, `--reconcile-pull`, `--reconcile-issue`), bounded same-repository REST reads that discard raw user prose and reject fork PRs/moved heads/pagination overflow, and local shadow reconciliation loops.
- **Local and hosted synthetic Aspire / OpenTelemetry boundary**:
  - `apphost.cs`, `telemetry.mjs`, `local-otel-sdk.mjs`, `aspire-smoke.mjs`, and `aspire-telemetry-smoke.mjs`: orchestrate the isolated synthetic shadow resource under Aspire AppHost (`17.0.0`, .NET `10.0.404`) and export sanitized low-cardinality traces, metrics, and correlated logs over authenticated loopback HTTPS OTLP only, leaving pure evaluators uninstrumented.

### `tools/engineering-coordinator/` — portable lane planner, runner, and local SQLite fencing

- **Runtime-independent orchestration** (provider-neutral, injected clock/transport/store, dispatch hard-disabled):
  - `project-config.mjs` and `planner.mjs`: validate closed project schemas, non-overlapping path ownership, acyclic task dependencies, risk ceilings, aging priority, critical-path tie-breaking, and active lane/path reservations.
  - `retry.mjs` and `provider-adapters.mjs`: enforce bounded exponential retry with `retry-after`, single-attempt `readAfterUncertainWrite` reconciliation, read-only tracker/inspector bounds, and `LIVE_DISPATCH_DISABLED`.
  - `coordinator.mjs` and `review-provider.mjs`: run isolated shadow ticks (`runTick`) with cooperative lease heartbeats, `AbortController` cancellation on lease loss, and pre-checkpoint task re-reads, plus shadow Copilot review request decisions gated by atomic intent claims and verified included capacity.
- **Local `node:sqlite` state adapters**:
  - `sqlite-state-store.mjs`, `event-journal.mjs`, and `review-intent-store.mjs`: implement transactional lane + `repo#issue` generation leases, a bounded 10,000-entry deduplicated reconciliation journal (`reconcileJournalOnce`), and a write-once `repo:pr:head` review intent store. Local/runner SQLite files do not provide cross-run GitHub-hosted atomic persistence on ephemeral Actions runners.

`example-policies.json` and replay fixtures use only synthetic repositories and identities with `mode: "disabled"` and `killSwitch: true`. `ONBOARDING.txt` records operator constraints and remaining gaps.

## Workflows and effective `main` protection boundary

SoftwareFactory maintains six GitHub Actions workflows under `.github/workflows/` (documented in [Workflow guide](WORKFLOWS.md)):

1. `validate.yml` (**Factory validation**): exact-head Linux test/98-95 coverage gate, isolated Linux Aspire OTLP/SQLite runtime validation, `build-test`, and `upload-coverage-javascript` on `pull_request`, `merge_group`, and `main`.
2. `windows-aspire.yml` (**Windows Aspire runtime**): exact-head `windows-aspire-runtime` validation on `windows-latest` across `pull_request`, `merge_group`, and `main`.
3. `shadow-reconcile.yml` (**Factory shadow reconciliation**): default-off (`FACTORY_SHADOW_ENABLED=true`), read-only protected-`main` metadata inventory and PR/issue identity listener (`workflow_dispatch`, 10-minute `schedule`, `issues`, `pull_request_target`, `push`, `workflow_run`).
4. `reusable-replay-smoke.yml` (**Reusable replay smoke**): exercises the pinned reusable consumer replay workflow (`afc3d223f287b029db32672908097efc67a259c9`) on contract changes, `merge_group`, and `main`.
5. `shadow-tests.yml` (**Engineering factory shadow replay**): `workflow_call` synthetic replay of pinned SoftwareFactory tests (`1208481843e73d1d2506085c654e84255303541d`); [docs/consumer-shadow-tests.yml](consumer-shadow-tests.yml) remains an inert example pinned to `fbecbf99b4c8e1696194bd6fa5220b2328cd1379`.
6. `otel-sdk-lock-evidence.yml` (**OpenTelemetry SDK dependency evidence**): isolated `@opentelemetry/*` lockfile integrity and registry provenance check on same-repo PRs.

### Ruleset vs. independent review reconciliation

Observed `main` branch rulesets combine repository ruleset `28054442` and organization ruleset `16162572` with zero bypass actors:

- **Enforced by `required_status_checks` (`28054442`)**: `build-test`, `upload-coverage-javascript`, and `windows-aspire-runtime` (GitHub Actions `integration_id: 15368`, `strict_required_status_checks_policy: true`), plus `code_coverage` (`minimum_coverage: 98`, `max_coverage_drop: 0`), `required_review_thread_resolution: true`, squash-only merges, and an `ALLGREEN` merge queue.
- **Enforced by `code_scanning` and secret scanning (`16162572`)**: `CodeQL` (`medium_or_higher` security alerts, `errors_and_warnings` alerts) and secret-scanning alert resolution run as separate ruleset gates rather than `required_status_checks` entries.
- **Shadow validation requirements (`required_approving_review_count: 0` live gap)**: because both GitHub `pull_request` rulesets set `required_approving_review_count: 0`, native GitHub rulesets do not mechanically enforce independent final-head review, and thread resolution never clears summary-only review findings. SoftwareFactory's shadow evaluators (`core.mjs`, `review-history.mjs`, `verifyCandidateGateReceipt`) require verified exact-head independent review from `trustedReviewers` (`APPROVED`, or allowlisted `copilot-pull-request-reviewer[bot]` `COMMENTED` on `Jamula/SoftwareFactory`) with `summaryDisposition: "clear"`, zero unresolved inline or summary findings, and zero blocking reviews, while authenticated live receipt acquisition and required CI/merge-gate wiring remain pending. Fork PRs skip platform runtime/coverage-upload jobs and fail closed on `build-test` and offline candidate gate verification.

## Not yet enabled for live autonomy

Live autonomous issue dispatch, live review/queue submission, and cross-run hosted atomic persistence remain disabled pending verified M01 gates:

- Ephemeral Actions runner disks cannot serve as the authoritative cross-run lease or terminal idempotency store; hosted persistence, restart recovery, and atomic fencing must be proven on GitHub before live dispatch or merge.
- Default-off shadow reconciliation (`shadow-reconcile.yml`) performs no repository mutations and requires explicit owner opt-in variables; hosted agent execution standardizes on native GitHub Cloud Agents (`copilot-swe-agent[bot]` / Repository Cloud Automations, see [GitHub-hosted Copilot pilot](GITHUB-HOSTED-COPILOT-PILOT.md)) gated on verified included quota, `$0` paid-overage billing hard stops, and independent review.
- Never check out or execute untrusted pull-request code in a privileged workflow, never trust policy or coverage assertions from an unverified PR head, and never synthesize approvals or required checks.

## Consumer model

FamilyTree (M03) is the first intended consumer after M01 SoftwareFactory acceptance; Spellbook (M04) and FamilyHub (M05) adopt independently, each pinned to a reviewed immutable SoftwareFactory commit SHA. Each consumer owns its trusted default-branch policy and retains its own branch protections, security and coverage gates (`>=95%` line / `>=90%` branch baseline, or stricter existing thresholds such as Spellbook `>=97%` line / `>=90%` branch), review rules (formal `APPROVED`), budgets, kill switch, and release process. FamilyHub migration readiness and separate consumer activation approval remain required. Repository identity, existing auto-merge settings, and shadow decisions grant no permissions.

## Local and hosted diagnostic runtime

`apphost.cs` orchestrates the synthetic shadow runner and authenticated loopback HTTPS Aspire Dashboard for optional local development and standard GitHub-hosted Linux/Windows CI verification (`validate.yml` and `windows-aspire.yml`). Orchestration/adapter boundaries emit OpenTelemetry signals to local OTLP only; pure decision modules remain side-effect free, with no public endpoint, external collector, or live provider calls. See [local development](LOCAL-DEVELOPMENT.md).

## Roadmap v2 operational target

The [roadmap](ROADMAP.md) and linked issue receipts govern M01–M05 acceptance. GitHub issues, PRs, trusted events, and supported GitHub-hosted execution orchestrate work; no laptop-hosted worker or continuous chat session is part of the operational path. Retain the Node.js control plane; any Rust execution-engine experiment belongs to M02 only after profiling and measured end-to-end evidence.

### GitHub-hosted execution topology

![GitHub orchestration, durable coordinator state, conditional workers, protected integration and independently authorized repositories](images/github-orchestration-v2.svg)

Verified included capacity and durable cross-run hosted state remain M01 acceptance blockers before live autonomous execution.
