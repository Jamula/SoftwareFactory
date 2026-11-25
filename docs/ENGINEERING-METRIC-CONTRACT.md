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

Every aggregate carries window, last observation, sample count, source completeness, stale/unknown status, and baseline cohort. Missing evidence is never zero. Do not infer DORA production metrics from local simulations. The 25× target is a hypothesis; report 2×/5×/10×/15×/20×/25× only as measured comparable ratios with quality and cost guardrails.

Acceptance fixtures: duplicate events, out-of-order events, missing timestamps, partial source coverage, zero denominator, stale observation, synthetic/live isolation, unauthorized scope, cohort changes and retention expiration. Storage/retention choice follows verified free/local capacity and restart tests.
