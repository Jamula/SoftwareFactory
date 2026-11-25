# Engineering standards and delivery expectations

These are the proposed common operating standards for SoftwareFactory and independently enrolled consumers. Mandatory safety and quality gates are distinct from velocity service-level objectives (SLOs). The current foundation is synthetic and read-only; documentation does not imply automated enforcement or activation. Owners may adopt stricter project-specific requirements, but cannot silently lower existing protections or approve spending by changing a policy file.

## Delivery velocity objectives

Measure elapsed wall-clock time and report p50/p95, sample size, observation period, blocked time and reason. Use the following initial targets for comparable small, independent changes; larger or security-sensitive work is measured separately. Targets are not permission to skip review or tests.

| Metric | Initial objective | Measurement |
| --- | --- | --- |
| Event reconciliation | p95 <= 2 minutes | Trusted event received to decision recorded |
| Eligible issue idle | p95 <= 2 minutes | Approved, unblocked, owned and funded issue becomes ready to confirmed dispatch |
| Eligible PR merge | p95 <= 2 minutes | Fresh verified eligibility plus merge authority to merge receipt |
| Standard fast CI | p50 <= 90 seconds; 30 seconds stretch where practical | Job start to required fast validation completion, excluding queue time (report queue separately) |
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
| Source line coverage | >=95% per executable component and overall |
| Source branch coverage | >=90% per executable component and overall |
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
