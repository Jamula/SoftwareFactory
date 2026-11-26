# Engineering velocity improvement program

Owner direction (2026-11-25 PT): remove bottlenecks and increase accepted engineering throughput, preserving all safety, quality, review, spending and release restrictions. M02 remains the critical path; use spare verified capacity for independent M03 slices. This is an experiment plan, not a claim that live parallel agents or event dispatch are operational.

## Observed baseline and limitations

| Observation | Evidence |
| --- | --- |
| Recent PR-created-to-merge proxy | #73 236.7 min; #77 38.4 min; #78 46.25 min; #79 16.77 min; #80 7.18 min |
| Review iterations | #73 returned 15 Copilot review summaries (including one after merge); repeated reviews and edits are a rework signal, not a measured cause of every minute |
| Linux validation sample | #80 build-test job 139747049167, ~52 s from first to last log; Node test/coverage ~10.5 s; AppHost runtime ~11.3 s |
| Windows validation sample | #79 run 45771965673, ~116 s full job from first to last log; restore/build ~62 s |
| Earlier 20-PR proxy | #9 comment 7184897305, p50 30.88 min, p95 78.98 min; merged-only mixed-size sample |
| Capacity and waiting | Actual concurrent agents, included quota, queue idle time, review wait, cost per accepted outcome and complete CI critical path are not yet measured |

Source: GitHub PR timestamps, review histories and hosted job logs. These are individual stage observations, not representative throughput or the full required-check SLO. In particular Linux job latency alone does not establish the <75-second full CI objective. #78/#79/#80 merge state alone did not establish full runtime or independent review acceptance. Do not repeat that pattern.

## Prioritized changes and acceptance

| ID | Owner issue | Change | Verification / rollback |
| --- | --- | --- | --- |
| V01 | #8 | Batch all current-head actionable review findings, including summary-only material concerns. Preflight acceptance, security and failure paths before publishing; review independently on exact final head. | Synthetic summary-only, incomplete, stale and conflicting inventory tests; measure distinct review heads and rework. Unknown review blocks; no self-approval. |
| V02 | #6 | Reserve one isolated worktree and owner per compatible lane, batch atomic changes and run local focused/full tests before pushing. | Simulate conflicts, dependency readiness and lease fencing; compare active vs idle lane time. Stop overlapping work and re-read on ref races. |
| V03 | #5 | Event-driven read-only reconciliation for check/review completion; periodic recovery remains fallback. | Measure event-to-decision p95, duplicates, missing and out-of-order events. No privileged untrusted code, live dispatch or new schedule. |
| V04 | #7 | Verify available included agent capacity and overage controls, then stage an authorized 1→2→4 worker pilot. | Prove provider entitlement, cancellation, lease, actual simultaneous runs and zero new spend before each increment. Unknown means no dispatch. |
| V05 | #8 / #16 | Gate protected merge trains on all exact-head material findings, actual platform/security/coverage checks and main verification; no premature merge. | Negative tests and independent evidence; measure eligible-to-merge and main failures; stop train on failed main. |
| V06 | #15 | Measure Windows restore and test safe locked dependency caching; avoid redundant validation only after equivalence proof. | Compare cold/warm p50/p95 including queue, all required jobs and review separately. Reject poisoned/mismatched caches; rollback on coverage, security or cost regression. |
| V07 | #9 | Measure accepted issues/day, ready-to-PR, review iterations, queue, CI, verified main and acceptance latency, blocked reasons and cost. | #83 initial outcome-correlation slice; use comparable cohorts and explicit missing evidence. |

## Working protocol (effective for safe direct work; automation implementation remains gated)

1. Read main and PR heads, active lanes, all review summaries and inline threads, checks and dependencies together; identify critical path and assign non-overlapping ownership. Do not equate logical lanes with live agents.
2. Batch known defects and negative tests in one candidate. In a verified isolated local worktree use the pinned runtime, locked restore, targeted tests then full coverage; check the candidate diff and `git diff --check`. A clean local result is advisory, not trusted CI or independent review.
3. Push one atomic candidate per lane with expected-head protection. Run required Linux/Windows, security and independent final-head review concurrently. While external validation is pending, start other independent approved work rather than repeatedly polling the same PR.
4. Treat summary-only findings as material until independently dispositioned. A successful review job, COMMENTED state or zero inline threads is not by itself approval. Resolve only substantiated findings; any new head invalidates prior review evidence.
5. Integrate in protected dependency order; verify main; count only accepted outcomes, not PR count. Report new blockers once. Do not bypass checks to meet speed objectives.

## Measurement and staged experiments

Use existing #9 measurement contract and reporting cadence. Compare at least five comparable accepted units per cohort as an initial exploratory minimum; disclose sample size, window, open/censored work and uncertainty. Aim for one to two validation rounds and the owner-directed 10-minute creation-to-merge objective (3 minutes draft-to-publish, 7 minutes publish-to-merge) plus 2 minutes merge-to-verified-main; target 2x then 5x accepted throughput after measured baseline, retaining 10x/25x stretch. No guaranteed speed multiplier. Stop any experiment that introduces missed findings, coverage regression, failed main, duplicate work, unauthorized mutations or unknown/increased cost. Later milestone features remain dependency-gated; no live provider dispatch, production deployment, credential changes, new paid services or review/protection relaxation.
