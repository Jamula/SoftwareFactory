# Operations and troubleshooting

## Current operation

Run the [synthetic replay](QUICKSTART.md) and inspect tests and reason codes. The system has no running dispatch or merge service, no durable execution state and no live metrics collector.

| Symptom | Response |
| --- | --- |
| Missing workflow or test file | Check exact pinned commit and checkout revision; do not switch silently to main |
| Replay failure | Investigate fixture and test failure, correct regression, repeat independently |
| Shadow blocked or disabled | Inspect reason; retain deny-by-default; do not force eligibility |
| Unknown review, check, quota or permission | Treat as blocked; request authoritative verification |
| Unintended privilege or possible secret leak | Stop the relevant workflow, revoke affected credentials via owner, report privately |

## Target operational controls

Before activation, prove a repository-local kill switch actually blocks dispatch and merge, including in-flight work and retries. Disable relevant workflow and revoke scoped authorization if needed; assess existing runs and pending merge requests. Preserve audit evidence and restore last reviewed pinned version only after resolving the issue. Do not delete audit history, weaken protection or automatically roll back production.

## Measurement

Collect comparable per-repository timestamps for approved-ready, dispatch, review, CI, eligible, merge, main verification and accepted work. Report median/p95 idle and cycle time, verified work units per day, review rounds, duplicate actions, failures and cost per accepted unit. Do not count PR volume alone or invent data. The 10× target is not a guarantee. Avoid logging issue contents, private records or tokens.
