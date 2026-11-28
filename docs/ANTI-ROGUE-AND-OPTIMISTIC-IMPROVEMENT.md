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

- **Repository-Isolated Causal Audit Index (`queryCausalAuditTrail(chains, filter)`):**
  Indexes completed autonomous causal chains with strict plain-object / anti-`Proxy`
  own-data-descriptor validation across all records (rejecting explicit `null`/`undefined`
  filter fields), enforces required `filter.repositoryId` isolation so cross-repository
  records or shared fork SHAs never leak or cross-block across tenants, verifies every
  target-repository chain's unbroken 9-link lineage via `verifyCausalProvenanceChain`
  (rejecting broken chains, partial `allowInFlightUpToStage` prefixes, per-repository
  duplicate `traceId` / `commitSha` / `squashCommitSha` / `pullNumber` entries, and
  circuit-breaker inputs mismatched with lineage paths/identities while keeping omitted
  circuit-breaker state as `null` rather than `false`), and supports deterministic
  chronological lookups by `repositoryId`, `traceId`, `deliveryId`, `issueNumber`,
  `pullNumber`, `commitSha`, `squashCommitSha`, or `violationCode`.
- **Candidate Proposal Generator (`proposeOptimisticImprovements`):** Synthesizes bounded,
  isolated, non-overlapping candidate proposals across SoftwareFactory
  (`"factory-velocity"`, `"knowledge-map"`) and enrolled products (`"enrolled-product"`)
  from `#18` scorecard bottlenecks, recurring CI/review `failureTaxonomy` entries, and
  operator/product `feedbackItems`. Proposals never mutate `main` or live policy directly
  (`directMainMutation: false`, `autoPolicyMutation: false`), require the full gate
  pipeline (`["ci-98-95", "codeql", "independent-review", "squash-merge-queue"]`), and set
  `requiresHumanApproval: true` whenever any target touches or encloses governance,
  ownership (`CODEOWNERS`, `.github/CODEOWNERS`, `docs/CODEOWNERS`), executable coverage
  and runner gates (`package.json`, `package-lock.json`,
  `tests/engineering-factory/coverage-reporter.mjs`, `no-python-guard.mjs`),
  independent-review (`review-history.mjs`, `review-batch.mjs`, `review-intent-store.mjs`,
  `review-provider.mjs`), workflow, policy, security, or budget contracts (including
  `optimistic-improver.mjs`, `ai-credit-scorecard.mjs`, and ancestor directories such as
  `tools/engineering-factory`, `tools/engineering-coordinator`, `config`, `agents`, or
  `.github`).
- **Matched Cohort Verification & Automatic Rollback (`verifyCohortImprovementOrRollback`):**
  Requires matching `repositoryId`, `cohortId`, `sourceKind: "verified-autonomous"`,
  `complete: true`, non-overlapping equal-duration windows (`beforeCohort.windowEndMs <=
  afterCohort.windowStartMs`), optional symmetric `distinctIssueNumbers` /
  `mergedPullNumbers` bindings (`distinctIssueNumbers.length === acceptedOutcomes`,
  `mergedPullNumbers.length >= acceptedOutcomes`), optional `cohortSource` allowlisted in
  `KAIZEN_COHORT_SOURCES` (`"synthetic-precohort-replay"`,
  `"github-verified-wave5-outcomes"`, `"live-unattended-ghaw-copilot"`), and `>= 5`
  comparable accepted outcomes in both `beforeCohort` and `afterCohort` (returning
  `status: "INSUFFICIENT_COHORT"`, `cohortComplete: false` when `< 5`). Once both cohorts
  reach `>= 5` accepted outcomes, deterministic rollback (`status: "ROLLBACK_REQUIRED"`,
  `rollbackRequired: true`) triggers immediately if coverage drops below `98%/95%` (or
  stricter consumer thresholds) or regresses relative to `beforeCohort`,
  `securityFindings > 0`, `mainFailures > 0`, routine human interventions increase in
  either absolute count or per-outcome rate, `reworkRateBps` (including `>10,000` bps
  repair-per-superstep ratios) regresses beyond tolerance, or AI-credit cost per accepted
  outcome exceeds baseline.
- **Bounded Automatic Revert Candidate Specification (`buildAutomaticRevertCandidateSpec`):**
  Consumes a `verifyCohortImprovementOrRollback` verdict (bound to `repositoryId`,
  `cohortId`, and optional `cohortSource`) and merged candidate metadata; fails closed
  when `rollbackRequired !== true`, when `repositoryId` / `cohortId` / `cohortSource`
  disagree, when inputs are malformed, proxy-wrapped, or out-of-lane, or when supplied
  `touchedPaths` / 9-link `provenanceChain` omit touched files from `targetPaths`, and when
  `rollbackRequired === true` emits an isolated, read-only revert PR specification
  (`directMainMutation: false`, `autoPolicyMutation: false`,
  `gatePipelineRequired: ["ci-98-95", "codeql", "independent-review",
  "squash-merge-queue"]`, exact `rollbackReasons`, verified 40-hex
  `targetRevertCommitSha`, `provenanceVerified` boolean, and
  `requiresHumanApproval: true` whenever `targetPaths`, `ownedPaths`, or contract metadata
  touch governed control-plane, workflow, policy, security, or budget surfaces).
- **Bound Kaizen Cohort Readout & Wave 5 Verification (`evaluateKaizenCohortReadout` &
  [`docs/evidence/m02-07-kaizen-audit-cohort.json`](evidence/m02-07-kaizen-audit-cohort.json)):**
  Distinguishes three provenance modes in `KAIZEN_EVIDENCE_MODES` (`"pre-cohort-synthetic"`,
  `"github-verified-cohort"`, `"live-autonomous-cohort"`) bound 1:1 to
  `KAIZEN_COHORT_SOURCES`. On `main` @ `4a4c6aeb5489921a84968840a8d1187d14c91108`
  (`cohortSource: "github-verified-wave5-outcomes"`), verifies `13` unbroken 9-link
  `Jamula/SoftwareFactory` causal chains with authentic exact-head
  `copilot-pull-request-reviewer[bot]` reviews and post-merge `Push on main` runs across
  pre-Kaizen baseline (`#160, #161, #164, #166, #167`, `5` distinct issues `[5, 6, 8, 9,
  14]`), shipped candidate (`#168`), and post-Kaizen Wave 5 (`#171, #172, #173, #175, #177,
  #178, #179`, `6` distinct issues `[6, 10, 11, 13, 14, 137]`), enforcing
  `governanceAttestation.accountingVerified = false` and `aiCreditsTotal: null` alongside
  `$0` verified billed overage, binding both baseline and post-rollout PR/issue/coverage
  sums to verified audit records, and setting `kaizenCohortVerified: true` and
  `issue137ReadyToClose: true` under the owner-approved streamlined M02 exit contract while
  keeping `liveAutonomousOutcomesCount: 0` and `liveCohortVerified: false`.
