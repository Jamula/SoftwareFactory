# Cloud Agent admission gate and unified CLI (`M01.07` `#7`, `M01.07.01` `#105`, `M01.05` `#8`, `M01.08` `#10`)

`tools/engineering-factory/cloud-agent-admission.mjs` provides `evaluateCloudAgentAdmission(input)`, a deterministic, metadata-only, read-only, fail-closed admission and capability evaluator for native **GitHub Copilot Cloud Agent (`copilot-swe-agent[bot]`)**, **Copilot Cloud Automations / Automation Groups**, and **`@microsoft/copilot-sdk` (`v2.0.3`)**. Every decision returns frozen plain JSON with `shadow: true` and `liveDispatch: false`; nothing performs live dispatch, merge mutations, credential handling, or paid provider requests.

## Non-negotiable input safety and telemetry contract

- **Strict plain-data inspection:** Every object and array is checked with `types.isProxy(v)` before `Array.isArray(v)` or prototype/key inspection, requiring `Object.prototype` / `Array.prototype` and own enumerable data descriptors (`enumerable === true` and `Object.hasOwn(descriptor, 'value')`). Revoked proxies, active proxies, getters, non-enumerable properties, symbols, sparse arrays, and custom prototypes fail closed without executing caller code.
- **Bounded telemetry & receipt mapping:** Every top-level `reason` returned by `evaluateCloudAgentAdmission` belongs to `tools/engineering-factory/telemetry.mjs`'s known `reasonLabels` allowlist (for example `'SHADOW_ALLOCATION'`, `'STOPPED'`, `'PROVIDER_FORBIDDEN'`, `'PROVENANCE_MISMATCH'`, `'CAPACITY_UNVERIFIED'`, `'CAPACITY_EXHAUSTED'`, `'BUDGET_UNKNOWN'`, `'BUDGET_OR_CONCURRENCY'`, `'STALE_QUOTA'`, `'POLICY_UNKNOWN'`, `'INVALID_POLICY'`, `'LANE_OR_PATH_RESERVED'`, `'LEASE_OR_CLOCK_UNKNOWN'`, `'WORK_RESERVATION_UNKNOWN'`, `'STALE_CHECKPOINT'`, `'INVALID_CANDIDATE'`, `'INVALID_IDENTITY'`, `'EVIDENCE_UNKNOWN'`). Fine-grained diagnostics are exposed in `admissionCode` and `detail` so `telemetrySummary` and `createExecutionReceipt` never collapse admission outcomes into `'OTHER'`.
- **Zero personal PATs (`#105`):** Any input where `personalPatInActionsSecrets !== false` is rejected immediately with `reason: 'PROVIDER_FORBIDDEN'` and `admissionCode: 'PERSONAL_PAT_FORBIDDEN'`.

## Four-part capability contract

`evaluateCloudAgentAdmission` separates provider readiness into four independent capability dimensions:

| Dimension | Required contract | Fail-closed denial |
| --- | --- | --- |
| `model` | `id` present in unique non-empty `allowlist`, `verifiedAvailable === true`, optional `provider` never equal to retired `'github-models'` (retired July 2026) | `'POLICY_UNKNOWN'` (`MODEL_NOT_ALLOWLISTED`), `'CAPACITY_UNVERIFIED'` (`MODEL_AVAILABILITY_UNVERIFIED`), `'PROVIDER_FORBIDDEN'` (`RETIRED_PROVIDER_FORBIDDEN`) |
| `harness` | `kind` in `['copilot-cloud-agent', 'copilot-cloud-automation', 'copilot-sdk']`, `verified === true`; optional `agentLogin` restricted to `'copilot-swe-agent[bot]'` on `'copilot-cloud-agent'`; pinned `sdkVersion` matching `'2.0.3'` (`'2.0.3'` or `'v2.0.3'`) required on `'copilot-sdk'` | `'PROVIDER_FORBIDDEN'` (`UNSUPPORTED_HARNESS`), `'PROVENANCE_MISMATCH'` (`AGENT_IDENTITY_MISMATCH`), `'CAPACITY_UNVERIFIED'` (`AUTOMATIONS_REQUIRE_PRIVATE_REPO`, `SDK_VERSION_MISMATCH`, `HARNESS_UNVERIFIED`) |
| `billingEntitlement` | `entitlementVerified === true`, `includedOnly === true`, `incrementalBilledUsdCents === 0`, verified `$0` overage hard-stops across all three meters, non-estimated fresh `accounting`, and supplemental `ghAwCaps` | `'BUDGET_UNKNOWN'`, `'STALE_QUOTA'`, `'INVALID_POLICY'`, `'BUDGET_OR_CONCURRENCY'`, `'CAPACITY_EXHAUSTED'` |
| `runner` | `kind` in `['github-hosted', 'cloud-sandbox']` with `verified === true`, `ephemeral === true`, and `isolated === true`; laptop, workstation, open-chat, and self-hosted operational runners are forbidden | `'PROVIDER_FORBIDDEN'` (`UNSUPPORTED_OPERATIONAL_RUNNER`), `'CAPACITY_UNVERIFIED'` (`RUNNER_ISOLATION_UNVERIFIED`) |

### Cloud Automation repository visibility rule

GitHub Copilot Cloud Automations and Automation Groups currently require `repositoryVisibility` in `['private', 'internal']`, whereas `github/gh-aw`, Copilot Cloud Agent (`copilot-swe-agent[bot]`), and `@microsoft/copilot-sdk` (`v2.0.3`) operate on `'public'`, `'private'`, and `'internal'` repositories. Requesting `harness.kind === 'copilot-cloud-automation'` when `repositoryVisibility === 'public'` fails closed with:

- `reason: 'CAPACITY_UNVERIFIED'`
- `admissionCode: 'AUTOMATIONS_REQUIRE_PRIVATE_REPO'`
- `detail: 'AUTOMATIONS_REQUIRE_PRIVATE_REPO'`

## `$0` Billing hard-stops and non-estimated AI Credit admission gate (`#105`, `#138`)

- **Why `gh-aw` soft caps are insufficient alone:** `github/gh-aw` `max-ai-credits` / `max-daily-ai-credits` (`ghAwCaps.maxAiCredits` and `ghAwCaps.maxDailyAiCredits`) are supplemental soft caps only because `gh-aw` can substitute a per-run estimate when historical usage cannot be read.
- **Mandatory verified accounting:** `evaluateCloudAgentAdmission` rejects missing, stale (`nowMs < observedAtMs` or `nowMs - observedAtMs > maxQuotaAgeMs`, default `60,000` ms, bounded `<= 300,000` ms), negative, non-integer, zero-run-credit, or estimated accounting (`accountingSource !== 'verified'` or `isEstimated !== false`) with `reason: 'BUDGET_UNKNOWN'` and `admissionCode: 'ACCOUNTING_ESTIMATED_OR_MISSING'`.
- **Exact integer currency math (`1 AIC = $0.01`):** AI Credits convert with exact integer arithmetic (`AI_CREDIT_USD_CENTS = 1`, `aiCreditsToUsdCents(credits)` where `1` AI credit equals `1` USD cent / `$0.01`).
- **Three-meter `$0` overage hard-stops:** Every meter in `BILLING_METERS` (`aiCredits`, `copilotPremiumRequests`, `cloudSandboxesAndActions`) must report `verified === true`, `paidOverageEnabled === false`, and `overageHardStopUsdCents === 0`, alongside `incrementalBilledUsdCents === 0`.
- **Dual cap enforcement:** Both single-run and multi-worker batch (`requestedWorkers * runAiCreditsRequired` and `requestedWorkers * premiumRequestsRequired`) usage must fit within `ghAwCaps.maxAiCredits`, `ghAwCaps.maxDailyAiCredits - dailyAiCreditsUsed`, `remainingIncludedAiCredits`, and `remainingIncludedPremiumRequests`.

## Staged `1 -> 2 -> 4 -> 8 -> 10 -> 12` worker ladder and fenced reservations (`#7`)

- **Single-step ladder progression:** `workerPool.requestedWorkers` must belong to `WORKER_LADDER` (`[1, 2, 4, 8, 10, 12]`), and `workerPool.verifiedPriorWorkerTier` must equal either `requestedWorkers` or the immediately preceding ladder tier (`0` for `1`), preventing unverified multi-tier jumps.
- **Fenced capacity calculation:** Active reservations (`expiresAtMs > nowMs`) consume capacity and enforce path/lane/issue/PR exclusivity; expired reservations (`expiresAtMs <= nowMs`) are reclaimed only when a retrying candidate presents a strictly newer CAS `leaseGeneration` (`candidate.leaseGeneration > expired.leaseGeneration`, otherwise `reason: 'STALE_CHECKPOINT'`, `admissionCode: 'STALE_FENCED_GENERATION'`). Candidate leases must also satisfy `0 < leaseExpiresAtMs - nowMs <= 3,600,000`.
- **Exclusivity (`LANE_OR_PATH_RESERVED`):** Duplicate `issue`, duplicate non-null `pr`, duplicate `lane`, or overlapping repo-relative `paths` (either among active reservations or between `candidate` and active reservations) fail closed with `reason: 'LANE_OR_PATH_RESERVED'`.
- **Actual worker ceiling and shortfall reporting:** Net available workers equal `Math.max(0, Math.min(repoConcurrencyCap, verifiedWorkerCeiling, remainingIncludedSlots) - activeReservations)`. `actualWorkerMax` is the highest `WORKER_LADDER` tier `<= netAvailableWorkers` (`0` when exhausted), and every result reports both `actualWorkerMax` and `workerShortfallFrom12` (`Math.max(0, 12 - actualWorkerMax)`).

## Unified `tools/engineering-factory/run.mjs` CLI

`tools/engineering-factory/run.mjs` exposes all read-only shadow evaluators behind a single entrypoint while preserving existing `--smoke`, `--inventory`, `--reconcile-pull`, `--reconcile-issue`, and `--receipt` behavior:

| CLI flag | Telemetry stage | Target evaluator | Input & output notes |
| --- | --- | --- | --- |
| `--smoke` (default) | `evaluate` | `smoke` (`./shadow-runtime.mjs`) | Synthetic self-check (`mode: 'synthetic'`, `liveDispatch: false`, `liveMerge: false`) |
| `--inventory` | `reconcile` | `readInventory` (`./shadow-runtime.mjs`) | Public issue/PR number inventory |
| `--reconcile-pull` | `reconcile` | `reconcilePullTrigger` (`./event-envelope.mjs`) | Protected `pull_request_target` metadata check |
| `--reconcile-issue` | `reconcile` | `reconcileIssueTrigger` (`./issue-event.mjs`) | Protected `issues` / `workflow_dispatch` check |
| `--reconcile-event` | `reconcile` | `reconcileEventTrigger` (`./event-envelope.mjs`) | Strips internal `snapshot` from stdout and normalizes receipt telemetry reasons |
| `--plan-lanes` | `evaluate` | `planLanes` (`../engineering-coordinator/planner.mjs`) | Reads `{config, tasks, active?, policy?}`; normalizes `SHADOW_PLAN` / `NO_READY_WORK` / `INVALID_TASKS` |
| `--evaluate-squash` | `merge-shadow` | `guardedSquashEvidence` (`./protected-squash.mjs`) | Reads `{intent, evidence, scope?}` via `evaluateProtectedSquash` |
| `--verify-admission` | `dispatch` | `evaluateCloudAgentAdmission` (`./cloud-agent-admission.mjs`) | Evaluates 4-part capability, `$0` AI-credit hard-stops, and `1->12` worker ladder |
| `--verify-m01-readiness` | `acceptance` | `verifyM01AutonomousExit` (`./pilot-readiness.mjs`) | Maps `'M01_EXIT_EVIDENCE_READY_ONLY'` and M01 denial codes cleanly for `--receipt` |

### Parameterized repository binding and bounded JSON input

- **Repository ID binding:** Expected repository ID defaults to `DEFAULT_REPOSITORY_ID` (`1471342715`, `Jamula/SoftwareFactory`) and may be parameterized via `options.repositoryId` or positive safe integer string `env.FACTORY_EXPECTED_REPO_ID`. Invalid expected IDs, conflicting `options.repositoryId` / `FACTORY_EXPECTED_REPO_ID`, or mismatched `env.GITHUB_REPOSITORY_ID` fail closed with exit code `1` (`PROVENANCE_MISMATCH` / invalid hosted receipt).
- **Bounded JSON input:** Subcommand payloads are supplied via `options.input` (plain JSON object or JSON string) or `env.FACTORY_INPUT_JSON`, capped at `MAX_INPUT_UTF8_BYTES` (`262,144` UTF-8 bytes) and validated recursively against proxies, getters, custom prototypes, non-finite numbers, and excessive depth/keys before execution.
- **Validation:** Run `npm run test:coverage` to verify exact-head `>=98%` line and `>=95%` branch coverage across all components.
