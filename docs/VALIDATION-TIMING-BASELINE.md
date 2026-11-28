# Initial validation timing baseline

This baseline covers pull requests #45 through #54 in Jamula/SoftwareFactory, observed on November 25, 2026 (Pacific time). It supports the CI evidence in #4 and the engineering measurements in #9.

| Pull request | Candidate commit | Validation job duration | Merge to main build result | Copilot review relative to merge |
| --- | --- | ---: | ---: | --- |
| [#45](https://github.com/Jamula/SoftwareFactory/pull/45) | `0bf1947` | [16 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45654005081/job/139345691851) | [19 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45654229947/job/139346484842) | After merge |
| [#46](https://github.com/Jamula/SoftwareFactory/pull/46) | `ec8452c` | [16 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45656324011/job/139353902690) | [23 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45656895581/job/139355884307) | After merge |
| [#47](https://github.com/Jamula/SoftwareFactory/pull/47) | `2f93c45` | [20 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45660125504/job/139367412960) | [26 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45660315549/job/139368070799) | Earlier commit |
| [#48](https://github.com/Jamula/SoftwareFactory/pull/48) | `8a44782` | [16 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45656726243/job/139355296456) | [38 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45656950168/job/139356224156) | Earlier commit |
| [#49](https://github.com/Jamula/SoftwareFactory/pull/49) | `96e96b0` | [12 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45657008589/job/139356283990) | [27 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45663448271/job/139379148980) | Rate limited on earlier commit |
| [#50](https://github.com/Jamula/SoftwareFactory/pull/50) | `b6b7adf` | [20 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45663662766/job/139379890798) | [Failed at +17 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45664137001/job/139381560799) | Earlier commit |
| [#51](https://github.com/Jamula/SoftwareFactory/pull/51) | `5d77c23` | [23 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45665625220/job/139386866181) | [30 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45666255842/job/139389087464) | Earlier commit |
| [#52](https://github.com/Jamula/SoftwareFactory/pull/52) | `78afc70` | [20 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45669053485/job/139399019684) | [26 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45669434240/job/139400373724) | Before merge |
| [#53](https://github.com/Jamula/SoftwareFactory/pull/53) | `07bc835` | [23 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45669926635/job/139402107450) | [24 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45670436419/job/139403942100) | Before merge |
| [#54](https://github.com/Jamula/SoftwareFactory/pull/54) | `7bc6cda` | [25 s](https://github.com/Jamula/SoftwareFactory/actions/runs/45722185879/job/139582975599) | Open | Review calls for runtime verification |

- Candidate validation: 10 successful jobs, p50 20 seconds, p95 25 seconds, range 12–25 seconds.
- Merge to confirmed passing main build: 8 successful results, p50 26 seconds, p95 38 seconds, range 19–38 seconds. One of nine merged commits failed its main build. The failed job for #50 reported a duplicate import, which #51 corrected. Report failures separately from latency for successful runs.
- PRs #52 and #53 each kept one candidate commit from opening through merge and had a formal Copilot review on that commit before merge. Opening to review was 101 and 142 seconds, respectively. Review to merge was 34 and 44 seconds. These two observations describe those PRs individually.

## How to reproduce

1. Read each GitHub PR's head commit and merge timestamp. Read its formal review records and compare the review's commit and submission time with the PR's head and merge time.
2. Read the GitHub check runs for the candidate commit. Select the `build-test` job published by GitHub Actions (app ID 15368) and measure completion minus start. This excludes runner queue time and other jobs.
3. For a merged PR, read the same job on the squash commit on `main`. Measure job completion minus PR merge time. Record failure and missing evidence explicitly.
4. Use nearest-rank percentiles. This is a small, same-day descriptive sample. The p95 equals the largest observation in each sample.

The review column records commit and timing, not approval: a comment on an earlier commit, a review after merge, or a rate-limit notice cannot establish the pre-merge review requirement. The sample lacks a consistent readiness or delivery timestamp, so it does not establish event-to-decision, queue latency, eligibility-to-merge, throughput improvements, cost, or any unattended delivery target.

## M02.01 multi-workflow cold baseline and exact-lockfile CI acceleration (November 28, 2026 UTC)

After the full Linux and Windows Aspire 17, OpenTelemetry, CodeQL, and `.NET MAF specialist agents` gates were enabled across protected `main` and `pull_request`, cold-cache CI execution and runner-pool contention pushed end-to-end validation well above the `<75 s` p50 target in #15 (`M02.01`). The machine-verifiable receipt is recorded in `docs/evidence/m02-01-ci-acceleration-receipt.json`.

### Protected `main` cold-cache baseline (`push` runs, zero `validate.yml` / `windows-aspire.yml` cache)

| Protected `main` commit | `test-coverage` | `linux-aspire-runtime` (`Restore` step) | `build-test` elapsed | `windows-aspire-runtime` (`Restore` step) |
| --- | ---: | ---: | ---: | ---: |
| `ec438f5` | [39 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46112285635/job/140878293132) | [51 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46112285635/job/140878293339) (24 s) | [61 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46112285635/job/140878500207) | [133 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46112285658/job/140878293210) (71 s) |
| `5796fda` | [37 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46107412650/job/140863153473) | [58 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46107412650/job/140863153693) (25 s) | [65 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46107412650/job/140863408385) | [140 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46107412677/job/140863153604) (76 s) |
| `b82b006` | [36 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46106944779/job/140861711298) | [49 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46106944779/job/140861711556) (19 s) | [58 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46106944779/job/140861919501) | [119 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46106944613/job/140861710668) (64 s) |
| `e269e82` | [36 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46104898073/job/140855328451) | [47 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46104898073/job/140855328625) (21 s) | [59 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46104898073/job/140855524029) | [114 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46104898093/job/140855328434) (63 s) |
| `b0924c3` | [39 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46101609302/job/140845083481) | [78 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46101609302/job/140845083688) (46 s) | [87 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46101609302/job/140845427660) | [116 s](https://github.com/Jamula/SoftwareFactory/actions/runs/46101609338/job/140845083870) (62 s) |

- Stage decomposition (`analyzeAspireRuntimeStages` on `ec438f5`): `restoreBuildMs` is the dominant bottleneck on both platforms (`76,000 ms` / `57.1%` of `133,000 ms` Windows runtime execution; `27,000 ms` / `52.9%` of `51,000 ms` Linux runtime execution), driven by cold network downloads of `Aspire.Cli 17.0.0` and NuGet AppHost/SDK packages on every job.
- Concurrent `pull_request` cold cohort (`dac9b25d`, `11ca4d4a`, `329b3ff2`, `aea2e90b`, `cc445acb` via `evaluateCiCriticalPath`): 5/5 passing samples across all 4 mandatory contexts (`build-test`, `upload-coverage-javascript`, `windows-aspire-runtime`, `CodeQL`), cold critical-path p50 `206 s` (`206,000 ms`), p95 `236 s` (`236,000 ms`), `5/5` misses against `<75 s` (`sloIsTimeoutOrGateWaiver: false`), amplified by `60–90 s` hosted-runner queue contention when non-.NET PRs also spawned `.NET MAF specialist agents` Linux/Windows VMs and `Factory shadow reconciliation` event runs.

### Poison-safe CI acceleration wired for `#15` (`M02.01`)

1. **Exact-lockfile `~/.npm`, `NUGET_PACKAGES`, and `Aspire.Cli 17.0.0` caching (`validate.yml` & `windows-aspire.yml`):** Read-only `actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9` on `github.event_name != 'push'` (PR and `merge_group` runs never write cache) and `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9` strictly on protected `main` `push` in `Jamula/SoftwareFactory` (`repository_id == '1471342715'`), with zero `restore-keys` prefix fallback and `Aspire.Cli` `17.0.0` binary version verification before skipping `dotnet tool install`.
2. **Deduplicated unit-test invocations inside Aspire runtime jobs:** Removed redundant `node --test` re-runs of `verify-dashboard-api.test.mjs`, `inspect-dashboard-metric-schema.test.mjs`, and `verify-dashboard-metric-receipt.test.mjs` inside `linux-aspire-runtime` and `windows-aspire-runtime` (already executed in `test-coverage`), preserving live `verify-dashboard-export.mjs`, `verify-dashboard-api.mjs`, and `verify-dashboard-metric-receipt.mjs` runtime verifiers.
3. **Pull-request path filtering on `.github/workflows/dotnet-agents.yml`:** Scoped `pull_request` runs to `.NET` / AppHost / lock / workflow paths while keeping `merge_group` and `push: branches: [main]` unconditional.
4. **Quieted legacy `.github/workflows/shadow-reconcile.yml`:** Restricted `on:` to manual `workflow_dispatch` now that `.github/workflows/factory-orchestrator.lock.yml` owns the `gh-aw` event matrix.

All required check contexts, 98%/95% JS and Coverlet coverage thresholds, TLS/authentication verifiers, and `$0` spend constraints remain unchanged. Post-merge warm-cache p50/p95 cohort measurement remains open before closing #15.
