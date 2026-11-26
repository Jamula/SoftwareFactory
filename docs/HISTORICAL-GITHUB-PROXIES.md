# Historical GitHub timing

This read-only report provides the historical proxy part of #9 and an input for #18. It uses public repository metadata and runs offline after collection.

## SoftwareFactory snapshot

The opening cohort is November 25, 2026, 00:00 through November 26, 2026, 00:00 Pacific (exclusive end). The GitHub snapshot was acquired November 26 at 11:24 Pacific (19:24 UTC).

| Proxy | Opened in window | Completed before cutoff | Censored at cutoff | Closed without merge before cutoff | Unknown | p50 | p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PR created → merged | 69 | 61 | 7 | 1 | 0 | 27m 51s | 6h 6m 21s |
| Issue created → closed | 3 | 1 | 2 | — | 0 | 3h 3m 23s | 3h 3m 23s |

The source was the [GitHub pull request list](https://api.github.com/repos/Jamula/SoftwareFactory/pulls?state=all&per_page=100&sort=created&direction=desc) and [issue list](https://api.github.com/repos/Jamula/SoftwareFactory/issues?state=all&per_page=100&sort=created&direction=desc), currently mutable views. Each returned fewer than 100 rows (78 PRs, 97 issue-list rows). Removing the 78 embedded PRs from the issue list left 19 actual issues. Numeric IDs, timestamps, and state were the only input fields retained for aggregation. A one-sample percentile is the same observation.

Censored includes items still open in the source and items with an end at or after the cutoff. The issue proxy uses the close timestamp visible in the snapshot. It does not reconstruct earlier closures or reopened transitions. Draft and review waiting is part of the PR proxy. An issue close or PR merge does not establish readiness, accepted work, main health, causal issue linkage, cost, or an SLO result. See [the separate CI baseline](VALIDATION-TIMING-BASELINE.md) and [the metric contract](ENGINEERING-METRIC-CONTRACT.md).

## Reproduce or consume the report

1. Fetch the relevant authorized repository's public PR and issue metadata without retaining bodies, titles, or actor fields. Follow pagination to the end of the relevant cohort. If source coverage cannot be established, set `sourceComplete: false`. Discard rows with `pull_request` from the issue dataset.
2. For each metric retain only `id` (issue or PR number), `repositoryId`, `metric`, `openedMs`, `endedMs`, and `state`. Use integer UTC epoch milliseconds. For `pr-created-to-merge` use the merge timestamp and `completed`, or the close timestamp and `closed-unmerged`. For `issue-created-to-close` use the visible close timestamp and `completed`. Leave the end null for `open` or `unknown`. Represent unavailable terminal timestamps with `unknown`. Do not combine metrics or repositories in a call.
3. Call `aggregateGithubTiming(rows, query, authorizedRepositoryIds)` from `tools/engineering-factory/stage-aggregate.mjs`. The trusted caller supplies the repository allowlist and a query with `repositoryId`, `metric`, `fromMs`, `toMs`, `observedMs`, `nowMs`, `maxAgeMs` and `sourceComplete`. The acquisition must be at or after the cohort cutoff. For a frozen historical report, record the generation time and provenance. For a live view, pass the real current time and refuse stale snapshots.
4. The response uses nearest-rank percentiles in milliseconds, based on completed samples only. It retains cohort, censored, closed-unmerged and unknown counts. Identical rows are deduplicated. Contradictory rows fail the entire query. Partial source coverage or unknown rows are flagged separately from exact measurements. Without a completed sample, p50 and p95 are null.

This interface does not collect data, launch a UI, or schedule a report. GitHub does not supply a consistent cross-repository cohort or verified acceptance in these list endpoints. A later report must bind those claims to authorized evidence. The historical proxy snapshot is separate from the synthetic stage metrics and does not close #9 or #18.
