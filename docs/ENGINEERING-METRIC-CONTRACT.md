# Engineering metric contract (draft)
Contributes to #18; coordinates #9, #15, #16. Aspire remains local diagnostics; this contract is for historical aggregates. No measurements are asserted here.

| Metric | Definition / provenance |
|---|---|
| Accepted throughput | Count distinct comparable work units with verified acceptance in window / elapsed days; PR counts secondary |
| Cycle time | Acceptance timestamp minus first authorized work start, p50/p95 plus sample count |
| Dispatch latency | First eligible timestamp to dispatch, excluding never-dispatched samples; report censored count |
| CI/review duration | Trusted workflow or review stage start/end, with exact candidate correlation |
| Rework | Distinct failed/reopened attempts per accepted unit; deduplicate attempt IDs |
| Cost | Verified attributable incremental spend / accepted units; unknown cost or denominator produces unknown |
| Utilization | Observed active time / observed allocated capacity, with coverage and idle/blocked breakdown |
| Coverage | Source covered/total line and branch counts per component, overall from counts; never average percentages |
| Improvement | Comparable accepted throughput / matched baseline; undefined when baseline missing or zero |

Record source kind (synthetic, verified live), schema version, authorized repository scope, bounded stage/outcome/reason enums, observation time, sanitized evidence key and deduplication key. Keep raw prompts, issue bodies, names, tokens and high-cardinality IDs out of metric labels. Restrict drill-down to authorized repository and sanitized evidence; no cross-repository private data.

Every aggregate carries window, last observation, sample count, source completeness, stale/unknown status, and baseline cohort. Missing evidence is never zero. Every ratio with a zero or unknown denominator is unknown (not zero or infinity), including cost per accepted unit, utilization, coverage and throughput; distinguish a genuinely measured zero numerator with a positive denominator. Do not infer DORA production metrics from local simulations. The 25× target is a hypothesis; report 2×/5×/10×/15×/20×/25× only as measured comparable ratios with quality and cost guardrails.

Acceptance fixtures: duplicate events, out-of-order events, missing timestamps, partial source coverage, zero denominator, stale observation, synthetic/live isolation, unauthorized scope, cohort changes and retention expiration. Storage/retention choice follows verified free/local capacity and restart tests.


## PR publication and completion SLO

| Stage | Start → end | Initial / stretch |
| --- | --- | --- |
| Draft to publish | PR creation → first ready-for-review event (or explicit ready-at-creation evidence) | 3 min / 1 min |
| Publish to merge | First publication → successful protected merge | 7 min / 3 min |
| Created to merge | PR creation → successful protected merge | 10 min / 4 min |
| Merge to verified main | Actual merge → exact merged commit independently verified healthy | 2 min / 1 min |

Use authoritative PR creation, ready-for-review timeline events, merge and main-verification evidence. Do not substitute updated_at for publication. A PR explicitly created ready has zero draft time; an unknown initial state or incomplete publication history is unknown. Clock starts at creation and first publication and never resets on re-draft, re-publication, head changes or retry. Report open elapsed ages separately as right-censored, not completed durations. Report p50/p95, sample size, window, missing/censored counts and SLO misses for comparable work, including overdue open PRs. Distinguish historical created-to-merge proxies from verified main and issue acceptance. Break delays down into runner queue, runtime (Linux/Windows), security, independent review, rework, ready-to-publish idle, eligible-to-enqueue idle, merge queue/revalidation and verification; do not sum overlapping stages. Use existing OTel/reporting boundaries. SLO is diagnostic, never grounds for skipping security, review, tests, coverage or protection, or adding spend.


## PR iterations and first-pass yield
Count distinct candidate heads, not commits or CI job count. Deduplicate stable validation-attempt identifiers; separate same-head infrastructure retries and merge-group revalidation from candidate rounds. Classify each new head as initial, review repair, CI repair, base refresh or unknown. Record open PRs as censored; report first-pass success only for complete merged evidence, with candidate-round and retry breakdown. Do not infer provider capacity, acceptance or costs from these counts. Historical adapters must normalize authoritative histories; incomplete histories are unknown.
