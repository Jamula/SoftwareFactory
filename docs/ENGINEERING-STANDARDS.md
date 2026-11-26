# Engineering standards and delivery expectations

These are the proposed common operating standards for SoftwareFactory and independently enrolled consumers. Mandatory safety and quality gates are distinct from velocity service-level objectives (SLOs). The current foundation is synthetic and read-only; documentation does not imply automated enforcement or activation. Owners may adopt stricter project-specific requirements, but cannot silently lower existing protections or approve spending by changing a policy file.

## Delivery velocity objectives

Measure elapsed wall-clock time and report p50/p95, sample size, observation period, blocked time and reason. Use the following initial targets for comparable small, independent changes; larger or security-sensitive work is measured separately. Targets are not permission to skip review or tests.

| Metric | Initial objective | Measurement |
| --- | --- | --- |
| Event reconciliation | p95 <= 2 minutes | Trusted event received to decision recorded |
| Eligible issue idle | p95 <= 2 minutes | Approved, unblocked, owned and funded issue becomes ready to confirmed dispatch |
| Eligible PR merge | p95 <= 2 minutes | Fresh verified eligibility plus merge authority to merge receipt |
| Standard fast CI | p50 <75 seconds; 30 seconds fast-feedback stretch | First validation job start to completion of all required automated validation checks (including security, coverage upload and platform checks); report p95, queue time and independent review separately |
| Small PR turnaround | p50 <= 30 minutes | Confirmed dispatch to verified merge; separately report main verification |
| Validation rounds | Aim for 1–2 | Distinct tested heads before successful merge |
| Stale or stalled work | Investigate at 10 hours; earlier for blocked critical path | Time since meaningful evidence update |
| Throughput | 10x baseline stretch | Comparable accepted work units per day, not PR count |
| Duplicate dispatch / unauthorized mutation | 0 | Confirmed duplicate leases / unauthorized writes |
| Incremental unapproved spend | $0 | Verified billing or quota evidence; unknown is blocked |

Establish a reproducible baseline before claiming gains. Report end-to-end acceptance latency, rework, failure rate and cost per accepted unit alongside speed. Do not multiply overlapping speedups. A missing metric is unknown, not zero. Report security/quality blockers immediately; use existing supervisory reporting cadence, not a new duplicate schedule.

## Mandatory quality and acceptance gates

| Gate | Required policy |
| --- | --- |
| Source line coverage | SoftwareFactory >=98% per executable component and overall; shared consumer baseline >=95% |
| Source branch coverage | SoftwareFactory >=95% per executable component and overall; shared consumer baseline >=90% |
| Stronger consumer gates | Retain the stricter existing threshold (e.g., Spellbook >=97% application line coverage) |
| Tests | All required build, unit, integration, E2E, platform and negative-path tests pass for the exact candidate |
| Security | Required scanning, dependency and secret checks pass; no unresolved blocking findings; independent security review for auth, persistence, CI, policy, privileges and other high-risk changes |
| Independent review | Verified current-head review from authorized independent reviewer, no unresolved material findings or threads; retain stricter repo-specific approval semantics |
| Merge | Exact expected head, verified required check producers, effective branch protections, compatible base, explicit authorization, no unresolved conversation |
| Post-merge | Verify main and affected integration; block dependents if verification fails |
| Acceptance | Close only after all linked acceptance criteria are evidenced; partial PRs use non-closing linkage |

Coverage must be measured from actual instrumented production source and the tested commit, with covered/total lines and branches for each executable component and overall. No averaging percentages across components; aggregate counts. Missing, empty, stale, malformed, ambiguous or mismatched reports fail closed. Branchless components require documented evidence and explicit justification, not a fabricated 100%. Exclude generated or non-production files only by documented, reviewed rules; no blanket exclusions, counting test code as production or weakening checks to attain a target. Add meaningful assertions for boundary, denial, failure, retry, cancellation, concurrency, rollback and recovery paths, not coverage-only executions. Current synthetic replay and a reported coverage number are not proof that hard gates are enforced.

For existing components below target, record measured debt, preserve every already-enforced gate, prevent regression, scope remediation and enforce the target before final acceptance/activation. No exception to mandatory authorization or security; any transitional coverage policy requires explicit owner approval, documented scope/expiry, compensating tests and an issue. It does not count as final target compliance.

## Parallel execution and review

- One agent owns each independent issue/file or contract lane; use dependency graph, path ownership, idempotent leases and bounded retries. Reuse existing work. No conflicting edits or duplicate agent requests.
- Start small draft PRs, batch fixes locally, run relevant checks before push, group review findings by exact head. Promote only after the implementation and evidence are ready. Re-review material head changes and invalidate stale evidence on all head changes.
- Run CI, independent code review and security review concurrently where safe. Reuse verified builds only when source, configuration, dependencies and artifacts are identical. Cancel only superseded PR runs, never required main/release runs. Do not remove checks or skip docs/drafts solely for velocity.
- Reconcile and merge independent eligible PRs incrementally, serialize per-repository merge decisions, verify fresh authoritative head/base and checks, then verify main and unblock dependencies. Never approve one's own implementation or fabricate a required status.
- Start with a verified per-repository concurrency limit; increase only after evidence of available included quota, isolated ownership and actual throughput improvement. The 8–15 agent ambition is not a default or an authorization. Unknown budget or capability blocks live dispatch.

## Governance, release and evidence

Every issue must describe scope, priority, acceptance, dependencies, ownership and risk. Every PR must identify its issue, exact tested head, checks, measured coverage, independent review, known limitations and any migration or rollback plan. Report built/tested/reviewed/merged/deployed/accepted separately.

Keep version 0.1.0 during pre-MVP development unless the owner separately approves a version change. No deployment, new credentials, new paid services, branch-protection changes or cross-repository rollout is implied by merge approval. Consumer adoption is individually pinned and opt-in. Keep secrets and private data out of public repositories and logs. Use least privilege, immutable action/workflow pins, separate trusted metadata and untrusted build jobs, per-repository kill switches and explicit owner authorization.

Use two-digit milestones M01, M02, etc., optional MNN.NN sub-milestones, and evidence-based ETA or TBD with dependencies and confidence. No fabricated progress. See [security policy](../SECURITY.md), [policy guide](POLICY.md), [operations](OPERATIONS.md), and [consumer onboarding](CONSUMER-ONBOARDING.md).

## Enforcement rollout

1. Document and independently review the standards.
2. Implement measured coverage gates and evidence validation, including negative tests; demonstrate exact-head CI and fail-closed behavior.
3. Implement trusted read-only event ingestion, idempotent reconciliation and metrics; compare shadow decisions with actual protected repository decisions.
4. Prove supported provider permissions, included quota, enforced branch protection, independent review and emergency stop before separately authorized dispatch or merge.
5. Pilot one consumer; expand only after verification. Each consumer can pause, pin or roll back independently.

Until these steps pass, remain shadow-only. No self-issued approvals or synthetic success signals may authorize a live action.

## 25× stretch program

The owner approved designing for 25× accepted engineering throughput, with 2×, 5×, 10×, 15× and 20× evidence-based checkpoints. See [milestone roadmap](ROADMAP.md). The initial objectives above remain the baseline operating SLOs; the following are additional experimental stretch objectives, not enforced guarantees or permission to bypass mandatory gates.

| Metric | Stretch objective |
| --- | --- |
| Event reconciliation and eligible dispatch | p95 <=15 seconds |
| Eligible merge latency | p95 <=30 seconds |
| Fast validation | p50 <=30 seconds |
| Small independent PR turnaround | p50 <=10 minutes |
| Productive agent utilization | 95% stretch; measure denominator and blocked time |
| Validation cycles | One typical, without suppressing review or tests |
| Accepted throughput | 25× comparable measured baseline |

Use critical-path scheduling, contract-first decomposition, independent specialist ownership, trusted repository knowledge, verified reusable components, safe build reuse and integration trains. Do not count logical lanes as simultaneous active agents. Scale only with verified included quota, isolated ownership and demonstrated gains. Preserve SoftwareFactory 98/95 and independent consumer gates (95/90 baseline or stricter), exact-head independent reviews, full integration/platform/security tests, $0 unapproved incremental spend, per-repo authorization and kill switches. Report failures and uncertainty. No new live enforcement is implied by this document.

## Local development and observability standard (owner-approved)

- **Aspire AppHost** is the standard local orchestration entry point for runnable SoftwareFactory components. Use the supported stable SDK/CLI and pinned compatible runtimes; preserve the existing pure Node evaluator. Headless tests remain independently runnable. Do not require a language rewrite or paid hosting.
- **OpenTelemetry** is the standard for traces, metrics and correlated structured logs. Instrument orchestration/adapter boundaries, not the pure decision function. Export locally via OTLP to the authenticated Aspire Dashboard; remote export is disabled unless separately approved. Keep resource health, trace correlation and sanitized low-cardinality metrics. No prompts, private text, identities, tokens or raw payloads. A missing exporter does not grant permission or manufacture success.
- Every runnable component documents a reproducible local startup/shutdown, synthetic fixtures, health checks, telemetry contract, failure behavior, and exact-head tests. Verify actual Windows runtime on standard hosted runners separately from compilation; workstation-specific testing is optional P2 #66. Use stable supported telemetry libraries; document limitations of log SDK maturity and any correlated-log bridge.
- SoftwareFactory receives first claim on verified included/free engineering capacity; do not cancel active consumer work, bypass gates, increase spending or activate a frozen consumer. The standard is a requirement for implementation, not a claim of current support. See [local development and observability](LOCAL-DEVELOPMENT.md), [#17](https://github.com/Jamula/SoftwareFactory/issues/17) and [#9](https://github.com/Jamula/SoftwareFactory/issues/9).

## CI consolidation (owner-directed, Nov 25, 2026)
Target eight meaningful checks where equivalent verification is proven. Preserve exact-head source inventory and 98/95 coverage, trusted native checks, all security/secret checks, independent review, merge-group validation and Linux/Windows runtime tests. Treat p50 <75 seconds as a service-level objective, not a timeout, test-selection waiver or reason to cancel a slow valid job. Report check counts, cold/warm p50/p95, queue/review latency and actual spend separately. Reduce repeated test process launches only after #67's exact-source inventory evidence is verified; do not disable GitHub Code Quality until coverage integration and equivalent quality verification are established. Retain trusted metadata event reconciliation. See #15.
