# Engineering standards and delivery expectations

These are the proposed common operating standards for SoftwareFactory and independently enrolled consumers. Mandatory safety and quality gates are distinct from velocity service-level objectives (SLOs). The current foundation is synthetic and read-only; documentation does not imply automated enforcement or activation. Owners may adopt stricter project-specific requirements, but cannot silently lower existing protections or approve spending by changing a policy file.

## Delivery velocity objectives

Measure elapsed wall-clock time and report p50/p95, sample size, observation period, blocked time and reason. Use the following initial targets for comparable small, independent changes; larger or security-sensitive work is measured separately. Targets are not permission to skip review or tests.

| Metric | Initial objective | Measurement |
| --- | --- | --- |
| Event reconciliation | p95 <= 2 minutes | Trusted event received to decision recorded |
| Eligible issue idle | p95 <= 2 minutes | Approved, unblocked, owned and funded issue becomes ready to confirmed dispatch |
| Eligible PR merge | p95 <= 2 minutes | Fresh verified eligibility plus merge authority to merge receipt |
| Standard fast CI | p50 <75 seconds; 30 seconds fast-feedback stretch | Candidate event to completion of all required automated validation checks (including security, coverage upload and platform checks); separately report first-job-start duration, p95, queue time and independent review |
| Small PR turnaround | p50 <= 10 minutes | Creation to merge; draft→publish 3 min, publish→merge 7 min, merge→verified main 2 min objectives |
| Validation rounds | Aim for 1–2 | Distinct tested heads before successful merge |
| Stale or stalled work | Investigate at 10 hours; earlier for blocked critical path | Time since meaningful evidence update |
| Throughput | 10x baseline stretch | Comparable accepted work units per day, not PR count |
| Duplicate dispatch / unauthorized mutation | 0 | Confirmed duplicate leases / unauthorized writes |
| Incremental unapproved spend | $0 | Fail-closed `gh-aw` `max-ai-credits` / `max-daily-ai-credits` (unknown accounting blocks startup) paired with verified GitHub Billing `$0` overage hard-stops (`1 AI credit = $0.01`); unknown is blocked |

Establish a reproducible baseline before claiming gains. Report end-to-end acceptance latency, rework, failure rate and cost per accepted unit alongside speed. Do not multiply overlapping speedups. A missing metric is unknown, not zero. Report security/quality blockers immediately; use existing supervisory reporting cadence, not a new duplicate schedule.

## Mandatory quality and acceptance gates

| Gate | Required policy |
| --- | --- |
| Source line coverage | SoftwareFactory >=98% per executable component and overall; shared consumer baseline >=95% |
| Source branch coverage | SoftwareFactory >=95% per executable component and overall; shared consumer baseline >=90% |
| Stronger consumer gates | Retain the stricter existing threshold (e.g., Spellbook >=97% application line coverage) |
| Tests | All required build, unit, integration, E2E, platform and negative-path tests pass for the exact candidate |
| Security | Required scanning, dependency and secret checks pass; no unresolved blocking findings; independent security review for auth, persistence, CI, policy, privileges and other high-risk changes |
| Independent review | Verified current-head review from authorized independent reviewer, no unresolved material inline threads or summary-only findings; retain stricter repo-specific approval semantics |
| Merge | Exact expected head, verified required check producers, effective branch protections, compatible base, explicit authorization, no unresolved conversation; final `main` integration runs through SoftwareFactory's deterministic `98%/95%` + summary-only review gate (`core.mjs` / `protected-squash.mjs`) and GitHub Native Squash Merge Queue (`gh-aw` refuses merges to `main`) |
| Post-merge | Verify main and affected integration; block dependents if verification fails |
| Acceptance | Close only after all linked acceptance criteria are evidenced; partial PRs use non-closing linkage |

Coverage must be measured from actual instrumented production source and the tested commit, with covered/total lines and branches for each executable component and overall. No averaging percentages across components; aggregate counts. Missing, empty, stale, malformed, ambiguous or mismatched reports fail closed. Branchless components require documented evidence and explicit justification, not a fabricated 100%. Exclude generated or non-production files only by documented, reviewed rules; no blanket exclusions, counting test code as production or weakening checks to attain a target. Add meaningful assertions for boundary, denial, failure, retry, cancellation, concurrency, rollback and recovery paths, not coverage-only executions. Current synthetic replay and a reported coverage number are not proof that hard gates are enforced.

For existing components below target, record measured debt, preserve every already-enforced gate, prevent regression, scope remediation and enforce the target before final acceptance/activation. No exception to mandatory authorization or security; any transitional coverage policy requires explicit owner approval, documented scope/expiry, compensating tests and an issue. It does not count as final target compliance.

## Parallel execution and review

- One agent owns each independent issue/file or contract lane; pair `github/gh-aw` (`v1.2.2+`) `tools.work-queue` (Protocol v4 non-force git-ref Compare-and-Swap `CAS` on a ruleset-protected `work-queue` branch + GitHub run-state crash recovery) with SoftwareFactory's deterministic dependency graph, non-overlapping file-set/lane scheduler (`planner.mjs`), bounded execution TTL (`coordinator.mjs`) and bounded retries. Keep Cloudflare Durable Objects (Free plan) strictly as an owner-approved escalation option if git-ref CAS contention ever warrants it; exclude Temporal and LangGraph. Reuse existing work. No conflicting edits or duplicate agent requests.
- Start small draft PRs, batch fixes locally, run relevant checks before push, group review findings by exact head. Promote only after the implementation and evidence are ready. Re-review material head changes and invalidate stale evidence on all head changes.
- Run CI, independent code review and security review concurrently where safe. Reuse verified builds only when source, configuration, dependencies and artifacts are identical. Cancel only superseded PR runs, never required main/release runs. Do not remove checks or skip docs/drafts solely for velocity.
- Reconcile and merge independent eligible PRs incrementally through SoftwareFactory's deterministic merge-eligibility gate and GitHub Native Squash Merge Queue (`gh-aw` refuses merges to `main`), serialize per-repository merge decisions, verify fresh authoritative head/base and checks, then verify `main` and unblock dependencies. Never approve one's own implementation or fabricate a required status.
- Execute hosted worker tasks via **GitHub Copilot Cloud Agent (`copilot-swe-agent[bot]`)**, **Copilot Cloud Automations / Automation Groups** (noting private/internal repository availability for Cloud Automations versus public-and-private repository support for `gh-aw` + Cloud Agent + `@microsoft/copilot-sdk` `v2.0.3`), and **Mission Control** task telemetry. Start with a verified per-repository concurrency limit; increase only after evidence of available included quota, fail-closed `max-ai-credits` / `max-daily-ai-credits` paired with provider-level GitHub Billing `$0` overage hard-stops (`1 AI credit = $0.01`), isolated ownership and actual throughput improvement. The actual `1→2→4→8→10→12` worker ladder is conditional on verified capacity and safety, not a default or an authorization. Unknown budget or capability blocks live dispatch.

## Governance, release and evidence

Every issue must describe scope, priority, explicit entry/exit criteria, dependencies, ownership, risk, measurable evidence and ETA/confidence (TBD if not supported). Roadmap v2 logical IDs supersede older IDs; retain historical references. Every PR must identify its issue, exact tested head, checks, measured coverage, independent review, known limitations and any migration or rollback plan. Report built/tested/reviewed/merged/deployed/accepted separately.

Keep version 0.1.0 during pre-MVP development unless the owner separately approves a version change. No deployment, new credentials, new paid services, branch-protection changes or cross-repository rollout is implied by merge approval. Consumer adoption is individually pinned and opt-in. Keep secrets and private data out of public repositories and logs; store zero personal PATs in Actions secrets. Use least privilege, immutable action/workflow pins, `gh aw compile` SHA-pinned `.lock.yml` workflows with frontmatter SHA-256 verification and `safe-outputs` read/write privilege separation (read-only sandboxed agent job → threat scan → scoped write jobs), separate trusted metadata and untrusted build jobs, deterministic merge/gate evaluators kept outside agent loops, per-repository kill switches and explicit owner authorization.

Use two-digit milestones M01, M02, etc., optional MNN.NN sub-milestones, and evidence-based ETA or TBD with dependencies and confidence. No fabricated progress. See [security policy](../SECURITY.md), [policy guide](POLICY.md), [operations](OPERATIONS.md), and [consumer onboarding](CONSUMER-ONBOARDING.md).

## Enforcement rollout

1. Document and independently review the standards.
2. Implement measured coverage gates and evidence validation, including negative tests; demonstrate exact-head CI and fail-closed behavior.
3. Implement trusted read-only event ingestion, idempotent reconciliation and metrics; compare shadow decisions with actual protected repository decisions.
4. Prove supported provider permissions, included quota, enforced branch protection, independent review and emergency stop before separately authorized dispatch or merge.
5. Demonstrate three independently accepted unattended SoftwareFactory issues on GitHub (M01), including parallel candidates and review repair, then pilot FamilyTree (M03); expand independently to Spellbook (M04) and FamilyHub (M05). M02 speed work may overlap without gating autonomy or consumer readiness. Each consumer can pause, pin or roll back independently.

Until steps 1–4 pass for the intended scope, remain shadow-only. After those minimum capabilities are independently verified and separately scoped live authorization, included capacity, $0 incremental cost controls, durable ownership and stop/recovery are established, a bounded SoftwareFactory acceptance pilot may execute step 5. Its actual independently accepted cycles supply M01 exit evidence; M01 completion is not a prerequisite to that pilot. This does not grant general dispatch, consumer activation or deployment authority. No self-issued approvals or synthetic success signals may authorize a live action.

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

Use critical-path scheduling, contract-first decomposition, independent specialist ownership, trusted repository knowledge, verified reusable components, safe build reuse and integration trains. In `M02`, inner specialist orchestration targets `.NET 10` + **Microsoft Agent Framework** (`Microsoft.Agents.AI` & `Microsoft.Agents.AI.Workflows` `1.28.0+` GA) deterministic Pregel superstep `Workflows` (`Executor`, `AddEdge<T>`, `AddFanOutEdge`, `AddFanInBarrierEdge`), cross-process JSON `CheckpointManager` (`ICheckpointStore<JsonElement>`), and `Microsoft.Agents.AI.GitHub.Copilot` (`1.28.0+` GA) alongside Copilot Cloud Agent and Cloud Automations execution. Do not count logical lanes as simultaneous active agents. Scale only with verified included quota, isolated ownership and demonstrated gains. Preserve SoftwareFactory 98/95 and independent consumer gates (95/90 baseline or stricter), exact-head independent reviews, full integration/platform/security tests, $0 unapproved incremental spend, per-repo authorization and kill switches. Report failures and uncertainty. No new live enforcement is implied by this document.

## Local development and observability standard (owner-approved)

- **Aspire 17 AppHost** (`.NET 10`) is the standard local orchestration entry point for runnable SoftwareFactory components. Use the supported stable SDK/CLI and pinned compatible runtimes; preserve the existing pure Node evaluator until equivalent measured proof is reviewed. Headless tests remain independently runnable. Do not require an unprofiled rewrite or paid hosting, and do not depend on GitHub Models (retired July 2026).
- **OpenTelemetry** is the standard for traces, metrics and correlated structured logs. Instrument orchestration/adapter boundaries—including current Node shadow adapters and `M02` Microsoft Agent Framework native `ActivitySource` (`Microsoft.Agents.AI.Workflows`) spans—not the pure decision function. Export locally via OTLP to the authenticated Aspire Dashboard; remote export and third-party SDK tracing (for example, `OPENAI_AGENTS_DISABLE_TRACING=1` on any deferred `M02.06` connector) remain disabled unless separately approved. Keep resource health, trace correlation and sanitized low-cardinality metrics. No prompts, private text, identities, tokens or raw payloads. A missing exporter does not grant permission or manufacture success.
- Every runnable component documents a reproducible local startup/shutdown, synthetic fixtures, health checks, telemetry contract, failure behavior, and exact-head tests. Verify actual Windows runtime on standard hosted runners separately from compilation; workstation-specific testing is optional P2 #66. Use stable supported telemetry libraries; document limitations of log SDK maturity and any correlated-log bridge.
- SoftwareFactory receives first claim on verified included/free engineering capacity; do not cancel active consumer work, bypass gates, increase spending or activate a frozen consumer. The standard is a requirement for implementation, not a claim of current support. See [local development and observability](LOCAL-DEVELOPMENT.md), [#17](https://github.com/Jamula/SoftwareFactory/issues/17) and [#9](https://github.com/Jamula/SoftwareFactory/issues/9).

## CI consolidation (owner-directed, Nov 25, 2026)
Target eight meaningful checks where equivalent verification is proven. Preserve exact-head source inventory and 98/95 coverage, trusted native checks, all security/secret checks, independent review, merge-group validation and Linux/Windows runtime tests. Treat p50 <75 seconds as a service-level objective, not a timeout, test-selection waiver or reason to cancel a slow valid job. Report check counts, cold/warm p50/p95, queue/review latency and actual spend separately. Reduce repeated test process launches only after #67's exact-source inventory evidence is verified; do not disable GitHub Code Quality until coverage integration and equivalent quality verification are established. Retain trusted metadata event reconciliation. See #15.


See [Engineering velocity improvement program](ENGINEERING-VELOCITY.md) for the measured bottleneck register, prioritized experiments and review-batching protocol. Summary-only material review findings require disposition even when inline threads are all resolved; a zero-thread count never establishes final independent approval.

## GitHub-hosted operation and architecture retarget (roadmap v2)

GitHub is the orchestrator and required execution environment; no personal laptop, always-on local service or open chat is an operational dependency:

- **`M01` outer orchestration & durable queue (`github/gh-aw` v1.2.2+):** Compile Markdown workflows via `gh aw compile` to SHA-pinned `.lock.yml` with frontmatter SHA-256 hash verification and `safe-outputs` read/write privilege separation (read-only sandboxed agent job → threat scan → scoped write jobs). Persist cross-run queue and claim state via `gh-aw` `tools.work-queue` (Protocol v4 non-force git-ref Compare-and-Swap `CAS` on a ruleset-protected `work-queue` branch + GitHub run-state crash recovery), paired with SoftwareFactory's thin deterministic moat: non-overlapping file-set/lane scheduling (`planner.mjs`), bounded execution TTL (`coordinator.mjs`), and exact-head `98%/95%` + summary-only review merge gating (`core.mjs` / `protected-squash.mjs`) via **GitHub Native Squash Merge Queue** (`gh-aw` refuses merges to `main`). Ephemeral runner SQLite, caches and artifacts alone do not prove durability or atomicity; **Cloudflare Durable Objects (Free plan)** is recorded strictly as an owner-approved escalation option if git-ref CAS contention ever warrants it, and **Temporal and LangGraph are excluded**. Pair fail-closed `max-ai-credits` / `max-daily-ai-credits` (unknown accounting blocks startup) with provider-level GitHub Billing `$0` overage hard-stops (`1 AI credit = $0.01`).
- **Worker execution (`M01` & `M02`):** Continue executing coding and automation work via **GitHub Copilot Cloud Agent (`copilot-swe-agent[bot]`)**, **Copilot Cloud Automations / Automation Groups** (available on private/internal repositories, versus public-and-private repository `gh-aw` + Cloud Agent + `@microsoft/copilot-sdk` `v2.0.3`), and **Mission Control** task telemetry.
- **`M02` inner orchestration & speed (`.NET 10` + Microsoft Agent Framework `1.28.0+` GA):** Retarget `M02`—superseding the optional Rust execution-engine experiment—to `.NET 10` + **Microsoft Agent Framework** (`Microsoft.Agents.AI` & `Microsoft.Agents.AI.Workflows` `1.28.0+` GA, replacing Semantic Kernel and archived AutoGen; note GitHub Models retired July 2026): deterministic Pregel superstep `Workflows` (`Executor`, `AddEdge<T>`, `AddFanOutEdge`, `AddFanInBarrierEdge`), cross-process JSON `CheckpointManager` (`ICheckpointStore<JsonElement>`), `Microsoft.Agents.AI.GitHub.Copilot` (`1.28.0+` GA), and native Aspire 17 `ActivitySource` (`Microsoft.Agents.AI.Workflows`) OTel spans. Aspire 17 remains for optional local development and hosted synthetic validation. Keep the pure Node deterministic evaluator authoritative until profiling, matched benchmarks, `>=98%/95%` coverage, independent review and rollback justify consolidation.
- **Deferred multi-vendor connector (`M02.06 P2`, [#136](https://github.com/Jamula/SoftwareFactory/issues/136)):** Defer future MCP / `IChatClient` / agent connector integration for ChatGPT/Codex (`openai/codex-action` / `@openai/agents` with external tracing disabled) and Claude (`anthropics/claude-code-action` / Claude Agent SDK `SessionStore` with `PreToolUse` `onFailure: "block"`), preserving SoftwareFactory's external deterministic gates, trusted base-branch config restoration and `$0` unapproved spend. See [roadmap v2](ROADMAP.md).
