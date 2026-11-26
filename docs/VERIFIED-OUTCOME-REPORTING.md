# Reporting accepted outcomes

The offline `measureAcceptedCohort` function in `tools/engineering-factory/outcome-measurement.mjs` supports the verified-outcome reporting part of #9 and the early read-only interface for #18. The [historical GitHub proxies](HISTORICAL-GITHUB-PROXIES.md) remain a separate source.

## Trusted inputs

Use `measureAcceptedCohort(entries, query, authorizedRepositoryIds)` with an authorized repository allowlist. Each query identifies a single `repositoryId`, configured comparable `cohort` label, and `source` (`verified` or `synthetic`). Callers establish the cohort definition, exact evidence provenance, and `complete` inventory coverage. A cohort label identifies a configured class of comparable work. It carries no issue, repository, or person names.

The query uses `fromMs` and `toMs` for a half-open acceptance window. Set `observedMs` to the trusted acquisition time and give the actual `nowMs` and a positive `maxAgeMs` to detect stale data. The observation must cover the cutoff. Each entry has `cohort`, `source`, `issue`, `pulls`, and `cost`. Keep issue and pull records to the fields required by `measureIssueOutcome`. Use exact main verification for the merge commits of every explicitly required pull request. A report has at most 500 issue entries; bound pull evidence to 250 rows per issue and 10,000 across the query.

For a closed issue, the per-issue verifier checks explicit acceptance, readiness, and reopen timestamps along with the required links and main verification. For an open issue, use a verified readiness timestamp and null acceptance. A missing or contradictory item counts as unknown. An item known to be ready but unfinished at the cutoff is right censored. Results count each accepted issue once; a duplicate input issue rejects the report.

Use null cost when no verified attribution exists. A measured cost entry needs `repositoryId`, `issueNumber`, an opaque `receiptId`, `verified: true`, `currency: 'USD'`, integer `amountMicros`, and `observedMs` at or after acceptance and no later than query acquisition. The trusted adapter establishes complete incremental attribution, including any documented allocation of shared spend. A credit balance or budget cap is separate evidence. Receipt reuse across any supplied verified outcomes or arithmetic overflow on in-window spend rejects the report. A verified zero receipt is measured zero; an absent amount never becomes zero.

## Interpret the result

- `counts` separates accepted, censored, unknown, and accepted items with verified cost. `p50` and `p95` are nearest-rank ready-to-acceptance durations in milliseconds, computed from verified samples only.
- `acceptedPerDay` divides distinct verified accepted items by elapsed days. It is null when inventory is incomplete or an outcome is unknown. It may be zero for a trusted complete cohort with no acceptances.
- `costPerAcceptedUsdMicros` is null until the cohort is complete, has at least one accepted item, and every accepted item has its own valid attribution receipt. The report does not use GitHub proxy durations or treat closed issues as automatically accepted.

Run the synthetic coverage and input-validation fixtures offline:

```shell
node --test --experimental-test-coverage --test-coverage-include='tools/engineering-factory/outcome-measurement.mjs' --test-coverage-lines=98 --test-coverage-branches=95 tests/engineering-factory/outcome-measurement.test.mjs
```

This is an aggregation interface. Actual accepted outcomes, cohort comparability, and cost provenance still need authorized evidence from the existing reporting cadence. End-to-end factory throughput, improvement over a baseline, agent utilization, and dashboard operation remain separate acceptance work.
