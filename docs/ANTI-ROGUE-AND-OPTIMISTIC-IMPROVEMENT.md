# Anti-Rogue Causal Audit, AI-Credit Scorecard, and Optimistic Improvement Loop

This document specifies the deterministic metadata-only evaluators implemented for
`M01.06` ([#9](https://github.com/Jamula/SoftwareFactory/issues/9)),
`M02.02` ([#18](https://github.com/Jamula/SoftwareFactory/issues/18)), and
`M02.07` ([#137](https://github.com/Jamula/SoftwareFactory/issues/137)). All three
components execute read-only (`shadow: true`, `liveMutation: false`) outside agent loops
and fail closed on missing, malformed, proxy-wrapped, or stale evidence.

## 1. End-to-End W3C `traceparent` Causal Provenance (`anti-rogue-audit.mjs`)

`verifyCausalProvenanceChain(chain)` validates an unbroken W3C `traceparent`
(`^00-(?!0{32})([0-9a-f]{32})-(?!0{16})([0-9a-f]{16})-([0-9a-f]{2})$`) correlation chain
with a single 32-hex `traceId`, distinct 16-hex `spanId`s, parent-span linkage, and
monotonic non-decreasing `observedMs` timestamps across all nine canonical autonomous
stages:

1. `eventDelivery` — `deliveryId`, `repositoryId`, `observedMs` (`parentSpanId: null`)
2. `ghAwLock` — 64-hex `lockSha256` of the compiled `gh-aw` `.lock.yml`, `observedMs`
3. `casLease` — `leaseGeneration >= 1`, `laneId`, leased `ownedPaths`, `observedMs`
4. `missionControlTask` — Mission Control UUID `taskId`, `sessionId`, `observedMs`
5. `candidateCommit` — 40-hex `commitSha`, `signed: true`, in-lane `touchedPaths`, `observedMs`
6. `exactHeadValidation` — `headSha === commitSha`, `ciReceiptId`, `codeqlReceiptId`,
   `coverageReceiptId`, `expectedComponents`, `coverageReports` verified per-component via
   `coverageEvidence(...)` (including optional head-bound `branchless` component
   justifications whose `reviewedBy` must be an independent authorized reviewer), and
   `lines`/`lineTotal` + `branches`/`branchTotal` bound to trusted repository policy
   (`1471342715` always requires `>=98%` lines / `>=95%` branches; consumers require
   `>=95%` / `>=90%` or stricter)
7. `independentReview` — `reviewId`, `reviewedHeadSha === commitSha`,
   `reviewerIdentity` distinct from both `authorIdentity` and
   `implementationAgentIdentity`, allowlisted in `authorizedReviewers`, acceptable
   `reviewState` (`APPROVED`, or SoftwareFactory Copilot bot `COMMENTED` when formal
   approval is not required), `reviewHistoryComplete === true`,
   `outstandingChangesRequested === 0` (plus optional `outstandingDismissedReviews === 0`
   and `normalizedReviews` verified free of `CHANGES_REQUESTED`, `DISMISSED`, or
   non-allowlisted `COMMENTED` entries), `unresolvedThreads === 0`, and
   `summaryFindingsResolved === true`
8. `mergeQueueSquash` — `expectedHeadSha === commitSha`, 40-hex `squashCommitSha`
9. `verifiedMain` — `mainCommitSha === squashCommitSha`, `mainHealthy === true`, `receiptId`

Partial in-flight chains may be inspected only when `allowInFlightUpToStage` is supplied
explicitly (`complete: false`, `inFlight: true`); final acceptance verification requires
all nine stages (`complete: true`).

## 2. External Anti-Rogue Circuit Breaker (`anti-rogue-audit.mjs`)

`evaluateAntiRogueCircuitBreaker(input)` runs outside the agent loop (`shadow: true`,
`liveMutation: false`), rejects path traversal (`..`, leading/trailing `/`, `\`, NUL),
and trips `tripKillSwitch: true` (`allowed: false`) with `telemetry.mjs`-compatible
reason codes (`SECURITY`, `POLICY`, `QUOTA`, `CHECKS`, `REVIEW`) on any of:

| Violation code | Trigger condition | Telemetry reason |
| --- | --- | --- |
| `SAFE_OUTPUTS_THREAT_FLAGGED` | `safeOutputsThreatDetected === true` | `SECURITY` |
| `PROTECTED_CONTROL_PLANE_TOUCH` | Autonomous touch or `selfMerge` on `.github/workflows/**`, `**/*.lock.yml`, `SECURITY.md`, `docs/POLICY.md`, `docs/ENGINEERING-STANDARDS.md`, `core.mjs`, `protected-squash.mjs`, `platform-merge-gates.mjs`, `coverage-evidence.mjs`, `budget.mjs`, `anti-rogue-audit.mjs`, `cloud-agent-admission.mjs`, `gh-aw-lock-verifier.mjs`, or ruleset/kill-switch files without `humanOwnerSignOffVerified === true` | `SECURITY` |
| `OUT_OF_LANE_EDIT` | Any `touchedPaths` entry outside leased `ownedPaths` | `POLICY` |
| `SELF_APPROVAL_FORBIDDEN` | `reviewerIdentity` matches `authorIdentity` or `implementationAgentIdentity` (case-insensitive) | `REVIEW` |
| `AI_CREDIT_ANOMALY` | `accountingVerified !== true` (omitted or `false`), `isEstimated === true`, `incrementalBilledUsdCents > 0`, `runAiCredits > maxRunAiCredits`, or `burnRateBps > maxBurnSpikeBps` | `QUOTA` |
| `RETRY_CAP_EXCEEDED` | `attempt > maxRetries` | `POLICY` |
| `POST_MERGE_MAIN_FAILED` | `mainHealthy === false` | `CHECKS` |

## 3. Reproducible AI-Credit & Autonomy Scorecard (`ai-credit-scorecard.mjs`)

`buildAiCreditAndAutonomyScorecard(input)` aggregates per-repository, per-cohort metrics
while strictly isolating `sourceKind: "historical-proxy"` from
`sourceKind: "verified-autonomous"`:

- **AI-credit & compute accounting:** `aiCreditsTotal`, `aiCreditsUsdCents`
  (`1 AI credit = 1 cent`), `aiCreditsPerAcceptedOutcome` (deduplicated per distinct
  accepted `issueNumber` / `workUnitId` while summing action-level credits across all
  retries with `Number.isSafeInteger` overflow checks failing closed as
  `UNSAFE_AGGREGATE_TOTAL`), `incrementalBilledUsdCents`,
  `confirmedIncrementalBilledUsdCents` (surfacing verified billed-spend violations in
  `bottlenecks` even when other rows lack accounting), `estimatedOrMissingCount`,
  `cloudSandboxMinutes`, and `actionsRunnerMinutes`. Missing or estimated values remain
  `null` and are never coerced to `0`.
- **Outer queue & inner MAF telemetry:** `ghAwQueueLatencyMs` (`p50`, `p95`, `sampleCount`,
  `unknownCount`) and `mafTelemetry` (`superstepsTotal`, `checkpointResumes`,
  `innerRepairIterations`, `reworkRateBps`).
- **Audit traceability & ranked bottlenecks:** `auditTraceability` (`totalActions`,
  `observedAuditActions`, `auditComplete`, `fullProvenanceActions`,
  `provenanceCompletenessPct` — `null` when `0` actions or partial — and lower-bound
  `killSwitchTrips` / `violationCounts` whenever `observedAuditActions > 0` so missing
  audit rows never mask a confirmed kill-switch trip; inconsistent records with
  `violations.length > 0` and `killSwitchTripped: false` fail closed) and deterministic
  ranked `bottlenecks` feeding `optimistic-improver.mjs`.

## 4. Optimistic Improvement Loop & Cohort Rollback (`optimistic-improver.mjs`)

- **Candidate Proposal Generator (`proposeOptimisticImprovements`):** Synthesizes bounded,
  isolated, non-overlapping candidate proposals across SoftwareFactory
  (`"factory-velocity"`, `"knowledge-map"`) and enrolled products (`"enrolled-product"`)
  from `#18` scorecard bottlenecks, recurring CI/review `failureTaxonomy` entries, and
  operator/product `feedbackItems`. Proposals never mutate `main` or live policy directly
  (`directMainMutation: false`, `autoPolicyMutation: false`), require the full gate
  pipeline (`["ci-98-95", "codeql", "independent-review", "squash-merge-queue"]`), and set
  `requiresHumanApproval: true` whenever any target touches or encloses governance,
  workflow, policy, security, or budget contracts (including ancestor directories such as
  `tools/engineering-factory` or `.github`).
- **Matched Cohort Verification & Automatic Rollback (`verifyCohortImprovementOrRollback`):**
  Requires matching `repositoryId`, `cohortId`, `sourceKind: "verified-autonomous"`,
  `complete: true`, non-overlapping equal-duration windows (`beforeCohort.windowEndMs <=
  afterCohort.windowStartMs`), and `>= 5` comparable accepted outcomes in both
  `beforeCohort` and `afterCohort` (returning `status: "INSUFFICIENT_COHORT"`,
  `cohortComplete: false` when `< 5`). Once both cohorts reach `>= 5` accepted outcomes,
  deterministic rollback (`status: "ROLLBACK_REQUIRED"`, `rollbackRequired: true`)
  triggers immediately if coverage drops below `98%/95%` (or stricter consumer thresholds)
  or regresses relative to `beforeCohort`, `securityFindings > 0`, `mainFailures > 0`,
  routine human interventions increase in either absolute count or per-outcome rate,
  `reworkRateBps` (including `>10,000` bps repair-per-superstep ratios) regresses beyond
  tolerance, or AI-credit cost per accepted outcome exceeds baseline.
