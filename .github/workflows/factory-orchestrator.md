---
name: Factory gh-aw outer orchestrator
description: Default-off GitHub Agentic Workflow outer orchestrator for SoftwareFactory
engine: copilot
if: "vars.FACTORY_GHAW_ENABLED == 'true' && github.repository == 'Jamula/SoftwareFactory' && github.repository_id == '1471342715' && github.ref == 'refs/heads/main' && github.ref_protected == true && !endsWith(github.actor, '[bot]') && (github.event_name != 'workflow_run' || github.event.workflow_run.head_repository.id == 1471342715)"
on:
  workflow_dispatch:
    inputs:
      issue_number:
        description: Optional issue number for read-only dry-run evaluation
        required: false
        type: string
        default: ''
      mode:
        description: Orchestrator execution mode (shadow reconciliation, synthetic smoke, or lock verification)
        required: false
        type: choice
        default: shadow
        options:
          - shadow
          - smoke
          - verify-lock
  schedule:
    - cron: '3,13,23,33,43,53 * * * *'
  issues:
    types: [opened, edited, labeled, unlabeled, closed, reopened]
  pull_request_target:
    branches: [main]
    types: [opened, reopened, synchronize, ready_for_review, closed]
  workflow_run:
    workflows: ["Factory validation", "Windows Aspire runtime", ".NET MAF specialist agents"]
    types: [completed]
  push:
    branches: [main]
permissions:
  contents: read
tools:
  github:
    mode: remote
    toolsets:
      - repos
      - issues
      - pull_requests
      - actions
  work-queue: true
safe-outputs:
  staged: true
  noop:
    max: 1
    report-as-issue: false
max-ai-credits: 50
max-daily-ai-credits: 200
---

# SoftwareFactory outer orchestrator (`github/gh-aw`)

Operate strictly as a **default-off, read-only outer evaluator** for `Jamula/SoftwareFactory` (`repository_id: 1471342715`).

## Non-negotiable invariants

1. **Default-off & loop-safe**: Never execute unless `vars.FACTORY_GHAW_ENABLED == 'true'` on protected `refs/heads/main`, never self-trigger on `*[bot]` actors, omit direct `pull_request_review` triggers so PR merge refs (`refs/pull/*/merge`) never execute PR-modified workflow YAML, and restrict `workflow_run` reconciliation to same-repository runs (`head_repository.id == 1471342715`) alongside the default-off 10-minute off-minute recovery schedule (`3,13,23,33,43,53 * * * *`).
2. **Metadata-only evaluation**: Never check out or execute untrusted pull request code, never interpolate GitHub expressions inside shell scripts, and never self-modify `.github/workflows/`, `.lock.yml`, rulesets, policy files, gate evaluators, or kill switches.
3. **Durable git-ref CAS & deterministic moat**: Coordinate cross-run queue claims exclusively through non-force Compare-and-Swap (`CAS`) on ruleset-protected `refs/heads/work-queue` (`work-queue-cas.mjs`, `protocol: v3` under pinned `github/gh-aw` `v1.2.2` @ `399a445fe2d8926c616b54b1b82a16b5b2be4445`) gated by `planner.mjs` non-overlapping file-set/lane ownership and `coordinator.mjs` bounded execution TTL (`<= 3,600,000 ms`).
4. **Privilege separation & native Merge Queue only**: Keep evaluation and threat/policy scan jobs strictly `contents: read`. Never configure `merge-pull-request` or invoke `gh pr merge`; **GitHub Native Squash Merge Queue** behind `98%/95%` exact-head coverage and summary-only independent review is the sole merge path to `main`.
