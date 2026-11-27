# Reporting accepted outcomes and velocity scorecards

The offline functions in `tools/engineering-factory/outcome-measurement.mjs` (`measureIssueOutcome`, `measureAcceptedCohort`, `buildVelocityScorecard`, `compareVelocityScorecards`) and `tools/engineering-factory/stage-aggregate.mjs` (`aggregateStage`, `compareStageWindows`, `aggregateGithubTiming`, `aggregateScorecardStages`) provide the reproducible read-only scorecard and aggregation contract for #18 (M02.02) and #9. [Historical GitHub proxies](HISTORICAL-GITHUB-PROXIES.md) remain strictly quarantined from autonomous outcome claims.

## Cohort outcome verification (`measureAcceptedCohort`)

Use `measureAcceptedCohort(entries, query, authorizedRepositoryIds)` with an authorized repository allowlist (`1..32` positive repository IDs). Each query identifies a single `repositoryId`, configured comparable `cohort` label, and `source` (`verified` or `synthetic`). Callers establish the cohort definition, exact evidence provenance, and `complete` inventory coverage. A cohort label identifies a configured class of comparable work and carries no issue, repository, or person names.

The query uses `fromMs` and `toMs` for a half-open acceptance window. Set `observedMs` to the trusted acquisition time (`observedMs >= toMs`) and supply `nowMs` and a positive `maxAgeMs` to fail closed on stale snapshots. Each entry has `cohort`, `source`, `issue`, `pulls`, and `cost`. Keep issue and pull records to the fields required by `measureIssueOutcome`. Use exact main verification for the merge commits of every explicitly required pull request. A report accepts at most 500 issue entries, 250 pull rows per issue, and 10,000 pull rows across the query.

For a closed issue, `measureIssueOutcome` checks explicit acceptance, readiness, and reopen timestamps along with required PR links and exact merge-SHA main verification. For an open issue, use a verified readiness timestamp and `null` acceptance. Missing or contradictory evidence counts as `unknown`. An item ready before `toMs` that remains open or accepts at/after `toMs` is right-censored (`censored`). Duplicate issue numbers, receipt reuse across verified outcomes, or safe-integer spend overflow fail closed.

Use `null` cost when no verified attribution exists. A measured cost receipt requires `repositoryId`, `issueNumber`, sanitized `receiptId`, `verified: true`, `currency: 'USD'`, non-negative integer `amountMicros`, and `observedMs` in `[acceptedAt, query.observedMs]`. A verified `$0` receipt (`amountMicros: 0`) is measured zero; an absent or unverified receipt is `unknown` (`null`), never zero.

## Speed and efficiency scorecard (`buildVelocityScorecard`)

Call `buildVelocityScorecard(input, authorizedRepositoryIds)` with exact keys `{ query, units, stageSamples, quality, historicalProxies, baseline }`:

1. **`query`**: `{ repositoryId, cohort, provenance, complete, stageSourceComplete, fromMs, toMs, observedMs, nowMs, maxAgeMs }`, where `provenance` is `'verified-autonomous-outcome'` or `'synthetic-fixture'`. Supplying `'historical-github-proxy'` or mixing provenances across `query`, `units`, `stageSamples`, `cost`, `quality`, or `baseline` fails closed with `reason: 'PROVENANCE_ISOLATION_VIOLATION'`.
2. **`units`**: up to 500 sanitized issue-unit records `{ cohort, provenance, issue, pulls, cost, rework, utilization, humanInterventions }`. Extra fields (such as titles, prompts, bodies, or actor names), proxies, and property getters are rejected without invoking accessors:
   - `rework`: `null` or `{ complete, candidateRounds, reworkRounds, reopenedCount, infrastructureRetries, queueRevalidations }` (`reworkRounds === candidateRounds - 1`, and `(issue.lastReopenedAt !== null) === (reopenedCount > 0)`).
   - `utilization`: `null` or `{ complete, activeMs, blockedMs, idleMs, blockedReasons }`, where `blockedReasons` sums to `blockedMs` over `ALLOWED_BLOCKED_REASONS`. When `allocatedMs === 0`, ratios remain `null` (`reason: 'ZERO_ALLOCATED_CAPACITY'`).
   - `humanInterventions`: `null` or `{ complete, routineCount, governanceCount }`. Incomplete or `null` tracking sets `status: 'unknown'` and `zeroRoutineVerified: false` (never `0`).
   - `cost`: distinguishes `status: 'verified-zero'` (`$0` verified across all accepted units), `'verified-spend'`, and `'unknown'` (`null` totals/ratios whenever `accepted === 0`, `complete === false`, or any accepted unit lacks a verified receipt).
3. **`stageSamples`**: evaluated by `aggregateScorecardStages(samples, stageQuery, authorizedRepositoryIds)` across all seven canonical M02.02 stages (`ready->firstPr`, `draft->publish`, `publish->merge`, `creation->merge`, `merge->verifiedMain`, `eligible->merge`, `ciEvent->lastRequiredCheck`). Reports nearest-rank `p50Ms`/`p95Ms` on completed in-window samples, `counts` (`cohort`, `completed`, `censored`, `unknown`), initial/stretch SLO miss counts, and `overdueOpenCount` for open items whose elapsed age at `observedMs` exceeds the initial target.
4. **`quality`**: `null` or `{ repositoryId, provenance, complete, coveredLines, totalLines, coveredBranches, totalBranches, minLinePercent, minBranchPercent, failedMainCount, unauthorizedWriteCount, duplicateDispatchCount, budgetViolationCount }`. Evaluates coverage directly from counts (`>= 95%` line / `>= 90%` branch floor; `98%` / `95%` for SoftwareFactory) and requires zero safety/budget violations.
5. **`historicalProxies`**: `null` or `{ provenance: 'historical-github-proxy', sourceComplete, issueCreatedToCloseRows, prCreatedToMergeRows }`. Output is isolated under `historicalProxyContext` (`nonAutonomousProxyOnly: true`) and never alters any autonomous velocity, cost, utilization, quality, or comparison field.
6. **`baseline` & sample-size gate (`compareVelocityScorecards`)**: requires `MIN_COMPARABLE_ACCEPTED_UNITS = 5` accepted units in both non-overlapping equal-duration windows of the same `repositoryId`, `cohort`, and `provenance`, positive baseline throughput, verified non-regressing cost per accepted unit, and `quality.status === 'passed'` before reporting `throughputMultiplier` or `THROUGHPUT_CHECKPOINTS` (`[2, 5, 10, 15, 20, 25]`). `autonomousSpeedClaimEligible` is `true` only when `provenance === 'verified-autonomous-outcome'`, `known === true`, `accepted >= 5`, rework and utilization are measured, `zeroRoutineVerified === true`, `cost.status === 'verified-zero'`, and `quality.status === 'passed'`.

## Verify offline

```shell
node --test --experimental-test-coverage --test-coverage-include='tools/engineering-factory/outcome-measurement.mjs' --test-coverage-include='tools/engineering-factory/stage-aggregate.mjs' --test-coverage-lines=98 --test-coverage-branches=95 tests/engineering-factory/outcome-measurement.test.mjs tests/engineering-factory/stage-aggregate.test.mjs
```

This read-only scorecard contract does not schedule workflows, collect external telemetry, or assert live autonomous velocity before #10 pilot receipts are independently verified.
