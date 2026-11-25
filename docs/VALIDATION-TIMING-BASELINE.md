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
