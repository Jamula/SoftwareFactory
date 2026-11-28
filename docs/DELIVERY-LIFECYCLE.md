# Delivery lifecycle (`v2` event-to-acceptance state machine)

![Target issue-to-merge lifecycle](images/lifecycle.svg)

SoftwareFactory's delivery loop is event-driven, dependency-aware, and **orchestrated natively on GitHub** (`M01` foundation `9 / 10` closed across `#4–#9, #17, #105, #118`; `#10` live 3-issue `@copilot` proof active; consumer rollout sequence **`M03` `Jamula/Spellbook` `#11` → `M04` `Jamula/FamilyTree` `#36` → `M05` `FamilyHub` `#12`** behind closed contract `#13`). No personal laptop, local polling loop, or open chat session is part of the operational loop.

| Stage | Shipped `v2` gate / evaluator | Required exit evidence |
| --- | --- | --- |
| **1. Discover** | Outer `github/gh-aw` (`v1.2.2+`) `.lock.yml` (`gh-aw-lock-verifier.mjs`) + `run.mjs --inventory` / `--reconcile-event` (`contents: read`, `safe-outputs` `staged: true`) | Verified trusted default-branch provenance, SHA-256 `.lock.yml` parity, stable `repositoryId`, and sanitized issue/PR metadata |
| **2. Ready & Admit** | `planner.mjs` non-overlapping file-set/lane scheduler + `work-queue-cas.mjs` non-force git-ref CAS on `refs/heads/work-queue` + `cloud-agent-admission.mjs` / `billing-hardstop-smoke.mjs` (`#6`, `#7`, `#105`) | Acyclic dependencies clear, disjoint path lease fenced with bounded TTL (`<= 3,600,000 ms`), verified non-estimated quota, and `$0` overage hard-stops across AI Credits, Copilot Premium Requests, and Cloud Sandboxes/Actions |
| **3. Specialist Execution** | Native GitHub Copilot Cloud Agent (`copilot-swe-agent[bot]`) / Cloud Automations (private/internal repos) + `.NET 10.0.404` Microsoft Agent Framework `1.28.0` GA Pregel superstep workflow (`src/SoftwareFactory.Agents/`, `curated-lessons.mjs`, `#14`, `#16`) | Scoped context loaded without private cross-repo data, SHA-256 JSON checkpoint integrity (`priorSuperstepsRepeated: 0`), zero protected control-plane or out-of-lane edits (`PathOwnershipGuard`), and Mission Control `taskId`/`sessionId` recorded |
| **4. Validate & Review** | Exact-head CI (`validate.yml` Node `26.13.1`, `dotnet-agents.yml` `.NET 10.0.404`, `windows-aspire.yml` Aspire `17.0.0`, `CodeQL`) + `Default-Branch-Ruleset` `28054442` (`review_on_push: false`) + `review-history.mjs` (`#4`, `#15`, `#17`, `#118`) | `>=98%` line / `>=95%` branch coverage per executable component and overall (or stricter consumer gates), zero `CodeQL`/secret alerts, exact-head independent review (`summaryDisposition: "clear"`), and zero unresolved inline or summary findings |
| **5. Eligible** | `core.mjs`, `coverage-evidence.mjs` (`verifyCandidateGateReceipt`), `protected-squash.mjs`, and `anti-rogue-audit.mjs` (`run.mjs --evaluate-squash`) | Fresh authoritative head/base match, unbroken pre-merge W3C `traceparent` links, and zero tripped circuit breakers (shadow decision only—never self-merge authority) |
| **6. Squash Merge Queue** | **GitHub Native Squash Merge Queue** (`Default-Branch-Ruleset` `28054442`, `grouping_strategy: "ALLGREEN"`, GraphQL `enqueuePullRequest` with `expectedHeadOid` and `jump: false`; `gh-aw` never merges directly) | Independent `merge_group` (`checks_requested`) green across required Linux/Windows checks and atomic squash commit on `main` |
| **7. Verify `main` & Audit** | `main-health-audit.mjs` + `anti-rogue-audit.mjs` (`#8`, `#9`, `#137`) | Protected `main` push checks green, complete **9-link W3C `traceparent` causal provenance receipt**, and `$0` incremental billed spend verified |
| **8. Unblock & Kaizen** | `work-queue-cas.mjs` terminal release + `ai-credit-scorecard.mjs` (`#18`) + `optimistic-improver.mjs` (`#137`) | Dependent issues unblocked, lane lease released cleanly, and matched `>=5`-outcome Kaizen cohort evaluated (auto-proposing revert spec on regression) |

Any moved `HEAD` SHA, stale/dismissed review, unresolved summary-only finding, unknown or estimated AI-credit balance, out-of-lane or protected-path touch, failed `main` check, or stop variable routes deterministically to `blocked` and trips the repository kill switch when required (`anti-rogue-audit.mjs`). Partial PRs use non-closing issue linkage so parent acceptance issues remain open until every exit criterion is evidenced. See [roadmap v2](ROADMAP.md), [operations](OPERATIONS.md), and [engineering standards](ENGINEERING-STANDARDS.md).

## Lifecycle state machine, sequence, and data flow diagrams

### 1. Issue-to-acceptance state machine (`stateDiagram-v2`)

```mermaid
stateDiagram-v2
  [*] --> Discovered: Trusted issue/event on protected main
  Discovered --> Admitted: Acyclic deps clear + $0 overage hard-stops (#105) + non-estimated quota (#7)
  Discovered --> Blocked: Missing/stale metadata or dependencies incomplete

  Admitted --> Leased: Non-force Git-Ref CAS claim on refs/heads/work-queue (disjoint ownedPaths)
  Admitted --> Blocked: CAS contention or lane already reserved

  Leased --> Implementing: Dispatch @copilot / .NET 10 MAF 1.28.0 specialist workflow
  Implementing --> Validating: Ready-for-review PR opened on exact HEAD SHA
  Implementing --> KillSwitchTripped: Protected control-plane or out-of-lane path touched

  Validating --> Reviewing: Linux/Windows CI (>=98%/95%), Aspire OTLP, and CodeQL green
  Validating --> Implementing: Bounded repair iteration (<= MaxRepairIterations)
  Validating --> Blocked: Fork PR, failing required check, or repair cap exhausted

  Reviewing --> Eligible: Exact-head independent review clear (0 inline or summary findings)
  Reviewing --> Implementing: Consolidated review-repair push on new HEAD SHA
  Reviewing --> Blocked: Stale/dismissed/CHANGES_REQUESTED review

  Eligible --> MergeQueued: enqueuePullRequest(expectedHeadOid, jump: false)
  MergeQueued --> MainVerified: merge_group ALLGREEN -> atomic squash + main push checks green
  MergeQueued --> Blocked: Base incompatible or merge_group check failure
  MainVerified --> KillSwitchTripped: Post-merge main regression detected

  MainVerified --> Accepted: Complete 9-link traceparent receipt + CAS lease released + dependents unblocked
  Accepted --> [*]
```

### 2. Review-repair and Squash Merge Queue sequence diagram

```mermaid
sequenceDiagram
  autonumber
  participant Worker as @copilot / .NET 10 MAF Lane
  participant PR as Candidate PR
  participant Checks as validate.yml + dotnet-agents.yml + windows-aspire.yml + CodeQL
  participant Rev as Independent Reviewer (Ruleset 28054442)
  participant Gate as core.mjs + protected-squash.mjs
  participant MQ as GitHub Squash Merge Queue (ALLGREEN)
  participant Main as Protected refs/heads/main

  Worker->>PR: Push candidate HEAD_1 & mark ready for review
  par Parallel Automated Checks & Single Review Trigger
    PR->>Checks: Run exact-head Linux/Windows 98%/95% + CodeQL
    PR->>Rev: Trigger review once (review_on_push: false)
  end
  Rev-->>PR: Inline comment or summary finding on HEAD_1
  Gate->>PR: Block eligibility (REVIEW_MISSING / unresolved thread)
  Worker->>PR: Batch all fixes into HEAD_2 + reply & resolve review threads
  PR->>Checks: Re-run exact-head checks on HEAD_2
  Checks-->>Gate: All checks green + coverage >=98%/95% on HEAD_2
  Rev-->>Gate: Exact-head HEAD_2 review clear (summaryDisposition: clear)
  Gate->>MQ: enqueuePullRequest(expectedHeadOid: HEAD_2, jump: false)
  MQ->>Checks: Trigger merge_group (checks_requested)
  Checks-->>MQ: ALLGREEN
  MQ->>Main: Squash commit landed on main
  Main->>Gate: Verify main-health-audit.mjs + emit 9-link W3C traceparent receipt
```

### 3. Stage-gate evidence data flow diagram

```mermaid
flowchart TD
  RAW["GitHub REST / Event Payloads"] --> STRIP["event-envelope.mjs + issue-event.mjs + pull-signals.mjs<br/>(Discard Untrusted Prose, Verify Repo ID & Head SHA)"]
  STRIP --> PLAN_DF["planner.mjs + work-queue-cas.mjs<br/>(Disjoint Path Lease + TTL <= 3600s)"]
  PLAN_DF --> ADMIT_DF["billing-hardstop-smoke.mjs + cloud-agent-admission.mjs<br/>(Verified Included Quota, $0 Overage Hard-Stops)"]
  ADMIT_DF --> EXEC_DF["curated-lessons.mjs + SpecialistWorkflowEngine<br/>(Scoped Context + SHA-256 Checkpoints)"]
  EXEC_DF --> GATE_DF["coverage-evidence.mjs + review-history.mjs + protected-squash.mjs<br/>(Exact-Head 98%/95% + Summary Review + Ruleset Parity)"]
  GATE_DF --> AUDIT_DF["anti-rogue-audit.mjs + main-health-audit.mjs<br/>(9-Link W3C traceparent Receipt)"]
  AUDIT_DF --> KAIZEN_DF["ai-credit-scorecard.mjs (#18) + optimistic-improver.mjs (#137)<br/>(>=5-Outcome Matched Cohort Readout & Auto-Revert Guard)"]
```
