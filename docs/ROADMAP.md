# SoftwareFactory delivery roadmap

The first unattended pilot takes an approved issue through implementation, independent review, protected integration, and verified acceptance without a person advancing routine steps. Prove that loop on SoftwareFactory before expanding it to consumers. Optimize for comparable accepted work per day and cost per accepted outcome.

## Starting point · November 25, 2026 PT

The shared foundation is tracked in [#1](https://github.com/Jamula/SoftwareFactory/issues/1) (closed). The portable coordinator, durable event journal, critical-path scheduler, shadow review provider, synthetic quota allocation and fresh-evidence reconciliation have merged ([#50](https://github.com/Jamula/SoftwareFactory/pull/50), [#59](https://github.com/Jamula/SoftwareFactory/pull/59), [#60](https://github.com/Jamula/SoftwareFactory/pull/60), [#61](https://github.com/Jamula/SoftwareFactory/pull/61), [#63](https://github.com/Jamula/SoftwareFactory/pull/63), [#64](https://github.com/Jamula/SoftwareFactory/pull/64)). They supply pieces of the delivery loop. The pilot validator has synthetic repeatability tests ([#65](https://github.com/Jamula/SoftwareFactory/pull/65)). Unattended delivery, real provider capacity and end-to-end cost still require evidence.

M02 has native coverage measurement and hosted Linux and Windows Aspire runtime checks. The SDK work in [#73](https://github.com/Jamula/SoftwareFactory/pull/73) exercises actual pinned exporters against a synthetic receiver. [PR #78](https://github.com/Jamula/SoftwareFactory/pull/78) adds dashboard-side trace and log checks. Full acceptance also requires dashboard-side metric receipt for the same synthetic workload. A dedicated workstation is optional. The issue audits record the remaining quality and runtime evidence ([#4](https://github.com/Jamula/SoftwareFactory/issues/4), [#17](https://github.com/Jamula/SoftwareFactory/issues/17)).

## Milestones in delivery order

M01 is the delivered foundation. **M02 is the first open milestone.** The numbers below govern the work queue and match the [GitHub milestones](https://github.com/Jamula/SoftwareFactory/milestones) and issue titles. Each parent ends with a capability someone can use and evidence that demonstrates it. Record that evidence on its tracking issues before closing the milestone. A merged PR can satisfy one step while the parent remains open.

Follow the sub-milestones from top to bottom within each parent. Numbers set priority among eligible items. The critical path to the first unattended factory is **M02 → M03 → M04 → M05**. After M05, M06 measurement and M07 adoption can proceed independently. Both M08 and M09 depend on M07 and their own repository's readiness. Family Hub's freeze does not hold up Spellbook or factory improvements.

### M01 · Reusable factory foundation

**Value at completion.** A maintainer can run the shared evaluator on a synthetic project and inspect a repeatable policy decision.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M01.01 | Run the shared evaluator using the documented quickstart and synthetic policy. | [#1](https://github.com/Jamula/SoftwareFactory/issues/1) |
| M01.02 | Use the shared repository, policy and contribution guides to reproduce the result. | [Quickstart](QUICKSTART.md) |

### M02 · Trust each factory build

**Value at completion.** A maintainer can decide whether a change is safe to integrate and use the authenticated local dashboard to diagnose its execution.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M02.01 | Validate the candidate source, trusted check producers, coverage counts and independent review. Exercise stale or missing evidence and unresolved findings. | [#4](https://github.com/Jamula/SoftwareFactory/issues/4) |
| M02.02 | Run the pinned synthetic workload on hosted Linux and Windows. Show a trace, a metric and a correlated log from the same workload at the authenticated Aspire dashboard. | [#17](https://github.com/Jamula/SoftwareFactory/issues/17), [#9](https://github.com/Jamula/SoftwareFactory/issues/9) |
| M02.03 | Integrate through existing protections and verify the squash commit on main. Link the candidate, checks, review, dashboard receipt and healthy main so another maintainer can reproduce the decision. | [#4](https://github.com/Jamula/SoftwareFactory/issues/4), [#17](https://github.com/Jamula/SoftwareFactory/issues/17) |

### M03 · A queue that explains its decisions

**Value at completion.** An operator can inspect an approved issue and see what can run next, who owns it, why it is blocked and what changed after a restart.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M03.01 | Read fresh issue, PR, review, check and main events in read-only shadow mode. Record trusted origin, repository and candidate. | [#5](https://github.com/Jamula/SoftwareFactory/issues/5) |
| M03.02 | Order ready work by dependencies and file ownership. Recover a durable lease on restart and demonstrate duplicate and out-of-order event handling. | [#6](https://github.com/Jamula/SoftwareFactory/issues/6) |
| M03.03 | Show the eligibility or blocking reason for a real candidate using its independent review, coverage, protection and base evidence. Rehearse a changed head and failed main. | [#8](https://github.com/Jamula/SoftwareFactory/issues/8) |
| M03.04 | Publish a repeatable read-only report of queue and stage times with issue links, sample counts and missing data. Demonstrate the whole shadow decision with zero repository mutations. | [#9](https://github.com/Jamula/SoftwareFactory/issues/9), [#18](https://github.com/Jamula/SoftwareFactory/issues/18) |

### M04 · Dispatch within budget and recover safely

**Value at completion.** Before activation, an operator can use the factory to decide whether an approved job fits verified included capacity and recover interrupted work without assigning it twice.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M04.01 | Verify a supported provider, the existing identity, included allowance, overage control, cancellation and repository caps. Demonstrate that unknown or exhausted capacity blocks dispatch. | [#7](https://github.com/Jamula/SoftwareFactory/issues/7) |
| M04.02 | Identify the event receiver, runner, durable store and restart owner. Account for the existing hourly coordinator. Exercise quota reservation, cancellation, stale leases and restart under concurrency in dry run. | [#7](https://github.com/Jamula/SoftwareFactory/issues/7), [#6](https://github.com/Jamula/SoftwareFactory/issues/6) |
| M04.03 | Rehearse a failed check, review finding, revised head, competing merges and failed main. Record bounded repairs, read-after-uncertain-write, serialized integration and stop/rollback. Show one reservation and one disposition per job. | [#5](https://github.com/Jamula/SoftwareFactory/issues/5), [#7](https://github.com/Jamula/SoftwareFactory/issues/7), [#8](https://github.com/Jamula/SoftwareFactory/issues/8), [#15](https://github.com/Jamula/SoftwareFactory/issues/15), [#16](https://github.com/Jamula/SoftwareFactory/issues/16) |

### M05 · Unattended SoftwareFactory delivery

**Value at completion.** Three real SoftwareFactory issues reach verified acceptance with zero routine human interventions and $0 incremental spend.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M05.01 | Verify readiness and obtain the separate bounded authorization for this repository. Confirm the effective checks, queue or serialized equivalent, quota, stop control and rollback. | [#10](https://github.com/Jamula/SoftwareFactory/issues/10) |
| M05.02 | Deliver one approved issue from ready through implementation, independent review, protected squash and verified main. Retain the receipt and verify the issue's acceptance criteria. | [#10](https://github.com/Jamula/SoftwareFactory/issues/10) |
| M05.03 | Complete at least two more independently accepted issues. Across the three, include a review-fix cycle and parallel candidates. Publish timings, human touches, failures, quota use and attributable cost for the full cohort. | [#10](https://github.com/Jamula/SoftwareFactory/issues/10) |

### M06 · Improve delivery speed at the same cost

**Value at completion.** Maintainers can identify the largest measured delay and use a verified improvement that preserves quality and cost per accepted outcome.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M06.01 | Use the early baseline to provide a historical view of comparable accepted outcomes, stage delays, rework, human interventions and actual cost, with isolated views for each authorized repository. Show provenance and unknowns. | [#18](https://github.com/Jamula/SoftwareFactory/issues/18), [#9](https://github.com/Jamula/SoftwareFactory/issues/9) |
| M06.02 | Classify failures and benchmark full CI against safe fast feedback, identical-input reuse or bounded repair. Keep all required platform and security verification. | [#15](https://github.com/Jamula/SoftwareFactory/issues/15) |
| M06.03 | Use a fresh repository and ownership map to decompose approved work and route specialists within verified capacity. Compare exploration time and rework. | [#14](https://github.com/Jamula/SoftwareFactory/issues/14) |
| M06.04 | Test serialized integration trains and allocation on comparable cohorts. Adopt the measured improvement with a rollback path. Report the 2×, 5×, 10×, 15×, 20× and 25× experiments with sample sizes; retain full issue acceptance for the stretch program. | [#16](https://github.com/Jamula/SoftwareFactory/issues/16) |

### M07 · An independent FamilyTree delivery

**Value at completion.** FamilyTree can adopt or roll back a pinned factory version and complete a separately authorized issue using its own policy.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M07.01 | Deliver a reusable onboarding package, component catalog, immutable adoption and rollback pins. Demonstrate two synthetic project profiles with different policies. | [#13](https://github.com/Jamula/SoftwareFactory/issues/13) |
| M07.02 | Verify FamilyTree #128/#120, identity, ownership, quota, stricter local gates and rollback. Exercise the pinned adapter in shadow with synthetic data. | [#36](https://github.com/Jamula/SoftwareFactory/issues/36) |
| M07.03 | After separate authorization, complete a bounded unattended FamilyTree issue through healthy main. Verify 95/90 or stronger local coverage and record throughput and cost. | [#36](https://github.com/Jamula/SoftwareFactory/issues/36) |

### M08 · Spellbook can evaluate its own changes

**Value at completion.** Spellbook maintainers can run a pinned read-only adapter and see a trustworthy decision under their app, WebKit and iOS requirements.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M08.01 | Verify Spellbook identity, included capacity, existing two-agent cap, 97/90 app coverage and native platform checks. | [#11](https://github.com/Jamula/SoftwareFactory/issues/11) |
| M08.02 | Run the pinned adapter against a candidate. Show the reason for its decision, stale-head denial, independent review, stop and rollback under Spellbook's own policy. Any live operation needs its own authorization. | [#11](https://github.com/Jamula/SoftwareFactory/issues/11) |

### M09 · Family Hub can evaluate changes after migration

**Value at completion.** After the migration freeze lifts, Family Hub maintainers can inspect a pinned review decision under their own branch protections and production isolation.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M09.01 | Confirm the repository identity, owner release of the migration freeze, exact-head formal approval requirement and strict up-to-date checks. | [#12](https://github.com/Jamula/SoftwareFactory/issues/12) |
| M09.02 | Demonstrate the pinned shadow adapter, denial of stale or dismissed approval, and rollback with production isolated. Any live operation needs its own authorization. | [#12](https://github.com/Jamula/SoftwareFactory/issues/12) |

### Work that can start early

During M02, collect read-only GitHub baseline data for M03.04 and verify whether included provider capacity evidence is available for M04.01. During M03, develop isolated repair fixtures for M04.03 and synthetic onboarding examples for M07.01. Report historical PR timings as proxies until readiness and verified outcome timestamps exist. Keep one owner for each change and reuse the existing reporting cadence.

An issue spanning several steps has one primary milestone in GitHub. Its links in the tables identify the steps it also supports. For example, #9 supplies M02 telemetry and M06 measurements, and #15 supplies M04 repair diagnostics before its M06 optimization work. Keep the full issue criteria when assessing closure. Older milestone references in historical comments, merged PRs and issue narratives use the previous numbering.

## Human decisions and operating limits

The owner supplies the objective, acceptance criteria and permitted repository scope. Within separately authorized operation, the coordinator selects ready work, reserves included capacity and assigns an isolated lane. The worker implements and tests the change. The coordinator requests independent review, routes findings for repair, verifies the revised commit, merges through existing protections, verifies main and records acceptance. Keep each issue's receipt from readiness through verified outcome. Resume interrupted work by reconciling that receipt against authoritative state before issuing another write.

Escalate unresolved intent, changes to budget or permissions, security exceptions, and failures that exhaust bounded recovery. Send one decision request with the affected issue, evidence, attempts and smallest decision needed. Keep independent eligible work moving within verified limits. Report both routine interventions per accepted issue and exception interventions by reason, including blocked and abandoned work.

The spending ceiling is **$0 incremental**. Unknown capacity blocks dispatch. Bound concurrency by verified included capacity, repository caps and non-conflicting ownership. Prefer deduplication and cancellation of superseded work before increasing concurrency. Chat execution and scheduled coordination need separate evidence of availability and persistence.

SoftwareFactory requires at least **98% source lines and 95% branches, per component and overall**, trusted checks on the candidate, security checks, and fresh base compatibility. Accept an independent Copilot `COMMENTED` review only on the exact candidate after actionable findings are addressed, threads are resolved and no blocking review remains. Preserve stricter consumer gates. An authorized protected squash on a reviewed PR does not activate the factory. Live provider activation, new spend, credential or permission changes, deployment and release each retain their separate authorization boundary.

## Scorecard for the self-pilot

| Measure | Definition and decision use |
| --- | --- |
| Autonomy | For each approved issue, count routine human touches through verified acceptance. Target zero. Report exceptions, failed and censored attempts alongside the three accepted cycles. |
| Speed | For comparable small issues, target ready → first PR **10 min**, PR → verified main **15 min**, ready → accepted outcome **25 min**. Stretch targets are 2/5/7 min. Track eligible → merge separately (p95 ≤120 s, 30 s stretch). |
| CI | Target p50 **<75 s** from first validation job start to the last required automated check, with a 30 s fast-feedback stretch. Report runner queue time and independent review time separately. |
| Throughput and cost | Count each verified, comparable issue outcome once per day. Track verified incremental spend, included usage, retries and rework per accepted issue. Missing cost or a zero denominator leaves cost per outcome unknown. |
| Quality and reliability | Report coverage counts and weakest component, failed main, recovery time, reopened work, suppressed duplicates and budget violations alongside throughput. Show the window, sample size, p50/p95, missing data and blocked time. |

The initial timing sample measured **20 s p50 for one successful build job** (10 observations). It does not establish whole-pipeline latency or an autonomy or throughput improvement. See the [timing baseline](VALIDATION-TIMING-BASELINE.md), [metric definitions](ENGINEERING-METRIC-CONTRACT.md), [engineering standards](ENGINEERING-STANDARDS.md) and [consumer adoption contract](CONSUMER-ADOPTION-CONTRACT.md).

## Outside the factory critical path

### M10 · Optional developer workstation compatibility

**Value at completion.** A developer can reproduce the documented Aspire startup, authenticated dashboard and clean shutdown on an existing supported workstation. The owner can request this after the factory is operational. M02 and the consumer pilots use their existing acceptance environments.

| Step | Work and evidence | Tracking |
| --- | --- | --- |
| M10.01 | On the requested workstation, record successful startup, dashboard access, shutdown and any compatibility findings. Reuse the hosted Windows and Linux evidence. | [#66](https://github.com/Jamula/SoftwareFactory/issues/66) · [M10](https://github.com/Jamula/SoftwareFactory/milestone/10) |

The Family Hub calling feature [#76](https://github.com/Jamula/SoftwareFactory/issues/76) is consumer product work and does not gate factory readiness. The full portfolio dashboard follows durable measurement. The baseline report starts now.
