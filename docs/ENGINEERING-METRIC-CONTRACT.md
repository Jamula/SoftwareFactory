# Engineering metric contract
Supports #18 (M02.02) and coordinates #9, #15, #16. Aspire remains local diagnostics; this contract defines read-only historical and scorecard aggregates (`tools/engineering-factory/outcome-measurement.mjs` and `tools/engineering-factory/stage-aggregate.mjs`). No live autonomous measurements are asserted by this document before verified #10 pilot evidence exists.

| Metric | Definition / provenance |
|---|---|
| Accepted throughput | Count distinct comparable work units with verified acceptance in `[fromMs, toMs)` / elapsed days; PR counts secondary |
| Cycle time (`ready->accepted`) | Verified acceptance minus issue readiness, nearest-rank p50/p95 plus sample count (25 min initial / 7 min stretch) |
| Ready to first PR (`ready->firstPr`) | Verified issue readiness to first candidate PR creation, excluding open/censored samples from percentiles (10 min initial / 2 min stretch) |
| CI check duration (`ciEvent->lastRequiredCheck`) | Trusted candidate event to completion of last required automated check (`p50 < 75 s` initial / `<= 30 s` stretch) |
| Eligible merge (`eligible->merge`) | Verified fresh merge eligibility plus authority to protected merge receipt (`p95 <= 120 s` initial / `<= 30 s` stretch) |
| Rework | Distinct candidate rework rounds (`candidateRounds - 1`) plus verified reopenings per accepted unit; deduplicate attempt IDs |
| Human interventions | Verified `routineCount` (0 objective) and separate owner `governanceCount`; missing or incomplete tracking is `unknown`, never `0` |
| Cost | Verified attributable incremental USD spend / accepted units (`verified-zero` `$0` vs `verified-spend` vs `unknown`); missing receipt or zero denominator is `unknown` |
| Utilization | Observed `activeMs / allocatedMs` (`activeMs + blockedMs + idleMs`), with bounded `blockedByReasonMs` (`DEPENDENCY`, `REVIEW`, `CI`, `QUOTA`, `MERGE_QUEUE`, `POLICY`, `SECURITY`, `OTHER`) |
| Coverage & safety | Exact-head component and overall covered/total line and branch counts validated against caller-configured `coveragePolicy` (`software-factory` floor >=98% / >=95%; `consumer` floor >=95% / >=90% or stricter) plus zero failed-main, unauthorized-write, duplicate-dispatch, and budget violations |
| Improvement | Comparable accepted throughput / matched baseline (`>= 5` comparable accepted units in both non-overlapping equal-duration windows, passed quality and measured rework/interventions on both, and no line/branch coverage, rework, intervention, or cost regression); undefined when baseline missing, zero, or guardrails regress |

## Provenance isolation

Every scorecard query and receipt carries an explicit provenance class from `SCORECARD_PROVENANCES`:

1. `verified-autonomous-outcome` — sanitized GitHub-hosted autonomous execution receipts.
2. `synthetic-fixture` — deterministic replay or simulation fixtures.
3. `historical-github-proxy` — public GitHub proxy snapshots (`issue-created-to-close`, `pr-created-to-merge`).

`aggregateScorecardStages`, `buildVelocityScorecard`, and `compareVelocityScorecards` enforce strict provenance isolation (`PROVENANCE_ISOLATION_VIOLATION`). Historical GitHub proxy records may be displayed only inside a quarantined `historicalProxyContext` section (`nonAutonomousProxyOnly: true`) and can never populate or blend into `throughput`, `stages`, `rework`, `utilization`, `humanInterventions`, `cost`, `quality`, `baselineComparison`, or `autonomousSpeedClaimEligible`. Synthetic fixtures can never set `autonomousSpeedClaimEligible: true` or compare against `verified-autonomous-outcome` cohorts.

Record provenance, schema version, authorized repository scope, sanitized cohort label, bounded stage/outcome/reason enums, observation time, and deduplication key. Reject extra fields, accessors, and proxies so raw prompts, issue bodies, titles, actor names, tokens, and high-cardinality IDs never enter scorecard records. Restrict evaluation to a single `repositoryId` in `authorizedRepositoryIds`.

Every aggregate carries `[fromMs, toMs)`, `observedMs`, sample counts, source completeness, censored/unknown counts, and cohort label. Missing evidence is never zero. Every ratio with a zero or unknown denominator is `null` (`unknown`), including cost per accepted unit, utilization (`ZERO_ALLOCATED_CAPACITY`), coverage, and baseline multiplier; a genuinely measured zero numerator with a positive denominator (`0` `$0` spend across `>= 1` accepted units with verified receipts, or `0` `activeMs` with positive `allocatedMs`) is preserved as `0`. Require `MIN_COMPARABLE_ACCEPTED_UNITS = 5` comparable accepted units before setting `exploratoryComparisonEligible` or computing `compareVelocityScorecards` multipliers (`2x`, `5x`, `10x`, `15x`, `20x`, `25x`).


## Canonical stage velocity and completion SLOs

| Stage key | Start → end | Initial / stretch |
| --- | --- | --- |
| `ready->firstPr` | Issue readiness → first candidate PR creation | 10 min (`600000 ms`) / 2 min (`120000 ms`) |
| `draft->publish` | PR creation → first ready-for-review event (`0 ms` if explicitly created ready) | 3 min (`180000 ms`) / 1 min (`60000 ms`) |
| `publish->merge` | First publication → successful protected merge | 7 min (`420000 ms`) / 3 min (`180000 ms`) |
| `creation->merge` | PR creation → successful protected merge | 10 min (`600000 ms`) / 4 min (`240000 ms`) |
| `merge->verifiedMain` | Actual merge → exact merged commit independently verified healthy | 2 min (`120000 ms`) / 1 min (`60000 ms`) |
| `eligible->merge` | Fresh verified eligibility + authority → protected merge receipt | 2 min (`120000 ms`) / 30 s (`30000 ms`) |
| `ciEvent->lastRequiredCheck` | Candidate event → last required automated check (`p50 < 75 s` initial) | `< 75 s` (`75000 ms`) / `<= 30 s` (`30000 ms`) |

Use authoritative PR creation, ready-for-review timeline events, merge and main-verification evidence. Do not substitute updated_at for publication. A PR explicitly created ready has zero draft time; an unknown initial state or incomplete publication history is unknown. Clock starts at creation and first publication and never resets on re-draft, re-publication, head changes or retry. Report open elapsed ages separately as right-censored, not completed durations. Report p50/p95, sample size, window, missing/censored counts and SLO misses for comparable work, including overdue open PRs. Distinguish historical created-to-merge proxies from verified main and issue acceptance. Break delays down into runner queue, runtime (Linux/Windows), security, independent review, rework, ready-to-publish idle, eligible-to-enqueue idle, merge queue/revalidation and verification; do not sum overlapping stages. Use existing OTel/reporting boundaries. SLO is diagnostic, never grounds for skipping security, review, tests, coverage or protection, or adding spend.


## PR iterations and first-pass yield
Count distinct candidate heads, not commits or CI job count. Deduplicate stable validation-attempt identifiers; separate same-head infrastructure retries and merge-group revalidation from candidate rounds. Classify each new head as initial, review repair, CI repair, base refresh or unknown. Record open PRs as censored; report first-pass success only for complete merged evidence, with candidate-round and retry breakdown. Do not infer provider capacity, acceptance or costs from these counts. Historical adapters must normalize authoritative histories; incomplete histories are unknown.
