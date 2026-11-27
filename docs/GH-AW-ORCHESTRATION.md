# GitHub Agentic Workflows (`gh-aw`) Outer Orchestration & Git-Ref CAS Queue

Relates to [#4](https://github.com/Jamula/SoftwareFactory/issues/4), [#5](https://github.com/Jamula/SoftwareFactory/issues/5), and [#6](https://github.com/Jamula/SoftwareFactory/issues/6) (`M01.01`, `M01.03`, `M01.04`).

SoftwareFactory standardizes `M01` outer orchestration on **GitHub Agentic Workflows (`github/gh-aw`)** compiled to an immutable SHA-pinned `.lock.yml` workflow, paired with a zero-cost, non-force **git-ref Compare-and-Swap (`CAS`)** queue and lease state machine on ruleset-protected `refs/heads/work-queue` and SoftwareFactory's deterministic file-set lane, bounded-TTL, and native Squash Merge Queue moat.

---

## 1. Lock Verification Contract (`tools/engineering-factory/gh-aw-lock-verifier.mjs`)

`verifyGhAwWorkflowLock({ markdownSource, lockYamlSource, pinnedRelease })` is a pure, deterministic, zero-network/zero-filesystem fail-closed evaluator that validates `.github/workflows/*.md` and compiled `.github/workflows/*.lock.yml` pairs before execution or CI acceptance:

| Verification rule | Enforced invariant | Fail-closed reason |
| --- | --- | --- |
| Strict input & proxy guard | Checks `types.isProxy(v)` **before** `Array.isArray(v)` (safe on revoked proxies), plain prototypes, and own enumerable data descriptors; rejects tabs/control characters | `INVALID_LOCK_INPUT` |
| Canonical `gh-aw` frontmatter & body SHA-256 binding | Computes `computeFrontmatterSha256` over sorted-key canonical JSON (`frontmatter-text`, plus `template-expressions` for `env.`/`vars.` interpolations or `body-text` when `inlined-imports: true`) and `computeBodySha256` matching `github/gh-aw` `v1.2.2` (`399a445fe2d8926c616b54b1b82a16b5b2be4445`), verifying `# gh-aw-metadata:` JSON (`schema_version` `v1`–`v4`, `frontmatter_hash`, optional `body_hash`, `compiler_version`) or legacy `# frontmatter-hash: <64-hex>` | `INVALID_FRONTMATTER`, `INVALID_LOCK_METADATA`, `FRONTMATTER_HASH_MISSING`, `FRONTMATTER_HASH_MISMATCH`, `BODY_HASH_MISMATCH` |
| Pinned `github/gh-aw` release & protocol compatibility | Verifies `compiler_version`, `# gh-aw-commit`, and any `github/gh-aw` action/checkout refs against pinned `v1.2.2` (`399a445fe2d8926c616b54b1b82a16b5b2be4445`). `v1.2.2` supports `tools.work-queue` `protocol: v3` only; `protocol: v4` is rejected unless an explicit `verified: true` newer semver + distinct 40-hex commit pin is supplied | `PINNED_RELEASE_INVALID`, `PINNED_RELEASE_MISMATCH`, `WORK_QUEUE_PROTOCOL_UNSUPPORTED` |
| Immutable Action SHA pins & trusted checkout provenance | Every `uses:` reference must match `owner/repo[/path]@<40-lowercase-hex>`; tags, branches, `docker://`, and relative local refs fail closed. Every `actions/checkout` step (matched case-insensitively) must set `persist-credentials: false`, and in write-capable `safe-outputs` jobs must explicitly set `with.ref` to `refs/heads/main` (or an independently verified SHA in `trustedControlPlaneShas` on `Jamula/SoftwareFactory` / `${{ github.repository }}`, or `pinnedRelease.commit` on `github/gh-aw`; omitted `ref`, `${{ github.workflow_sha }}`, and unallowlisted 40-hex SHAs fail closed) | `UNPINNED_ACTION_REFERENCE`, `CHECKOUT_CREDENTIALS_PERSISTED`, `UNTRUSTED_SAFE_OUTPUT_CHECKOUT` |
| Script injection prevention | Rejects any `${{ ... }}` GitHub expression interpolation inside `run:` blocks; untrusted or dispatch inputs must pass exclusively via `env:` | `UNSAFE_RUN_INTERPOLATION` |
| Least-privilege, helper/agent/scan role separation & `safe-outputs` gate | Workflow-level `permissions:` must be read-only (`contents: read` or `{}`). Compiler helper jobs (`activation`, `pre_activation`, `conclusion`, `unlock`) allow read-only `contents`/`actions`/`metadata` only; `agent`/`evaluate` and threat/policy scan (`threat-and-policy-scan`, `detection`) jobs must be read-only, must not set `continue-on-error: true`, and must not place step-level `if:` conditions inside scan jobs. Enabled write-capable `safe-outputs` jobs must require `needs.<eval>.result == 'success'`, `needs.<scan>.result == 'success'`, and `needs.<scan>.outputs.scan_verified == 'true'` without `always()`/`failure()`/`cancelled()`/`||` (or be hard-disabled via `if: false` / `if: ${{ false }}`) and cannot request `contents: write` or `workflows: write` | `TOP_LEVEL_WRITE_PERMISSION`, `INVALID_TOP_LEVEL_PERMISSIONS`, `AGENT_JOB_WRITE_PERMISSION`, `MISSING_THREAT_SCAN_GATE`, `EXCESSIVE_SAFE_OUTPUT_PERMISSION` |
| No `gh-aw` merge to `main` | Rejects any configured `safe-outputs.merge-pull-request` unless explicitly `false` or absent, plus merge jobs or `gh pr merge` steps; **GitHub Native Squash Merge Queue** is the sole merge path | `MAIN_MERGE_FORBIDDEN_IN_GHAW` |
| Bounded conjunctive AST default-off & bot loop guards | Bounds token count (`<= 64`) and nesting depth (`<= 16`), parses `if:` expressions into an AST (banning `always()`/`failure()`/`cancelled()`) on **both** `.md` source frontmatter `if:` and `.lock.yml` evaluation/activation jobs, proving `vars.FACTORY_GHAW_ENABLED == 'true'` and the non-bot guard (`!endsWith(github.actor, '[bot]')` or explicit bot exclusions) are top-level mandatory `&&` conjuncts | `MISSING_DEFAULT_OFF_GUARD`, `MISSING_BOT_LOOP_GUARD` |

---

## 2. Default-Off Orchestrator Workflow (`.github/workflows/factory-orchestrator.*`)

- **`.github/workflows/factory-orchestrator.md`** defines the canonical outer orchestrator specification using `tools.work-queue: true` (matching `github/gh-aw` `v1.2.2` `main_workflow_schema.json`, while SoftwareFactory's `protocol: v3` / `refs/heads/work-queue` contract assertions are verified outside the compiler-restricted frontmatter schema), read-only permissions, supplemental `max-ai-credits` / `max-daily-ai-credits` soft caps, and scoped `safe-outputs` without `merge-pull-request`.
- **`.github/workflows/factory-orchestrator.lock.yml`** triggers **exclusively on `workflow_dispatch`** (with `issue_number` and `mode` inputs) so zero skipped or `action_required` workflow runs are created on pull requests or `merge_group` events while `vars.FACTORY_GHAW_ENABLED` is unset.
- Job pipeline:
  1. `evaluate` (`permissions: contents: read`, gated by `vars.FACTORY_GHAW_ENABLED == 'true'`, protected `refs/heads/main`, repository ID `1471342715`, and `!endsWith(github.actor, '[bot]')`) verifies its own `.md`/`.lock.yml` SHA-256 integrity via `verifyGhAwWorkflowLock` and executes the read-only synthetic smoke check.
  2. `threat-and-policy-scan` (`needs: [evaluate]`, `permissions: contents: read`) re-verifies lock and non-mutation invariants before any downstream output stage.
  3. `safe-outputs-dry-run` (`needs: [evaluate, threat-and-policy-scan]`, `if: ${{ false }}`) remains hard-disabled until separate live authorization, verified `$0` GitHub Billing overage hard-stops (`#105`), and fail-closed budget admission (`#7`) are complete.

---

## 3. Git-Ref CAS Work Queue & Crash Recovery (`tools/engineering-coordinator/work-queue-cas.mjs`)

Ephemeral GitHub Actions runner filesystems (`node:sqlite`, caches, and workflow artifacts) do not provide atomic cross-run lease fencing. `work-queue-cas.mjs` implements the zero-cost GitHub-hosted state machine over an injected git-ref adapter on `PROTECTED_WORK_QUEUE_REF = "refs/heads/work-queue"`:

- **Non-force git-ref CAS (`compareAndSwapRef`)**:
  - Reads `{ oid, state }` from `refs/heads/work-queue` (`ZERO_GIT_OID` when uninitialized) and commits state transitions only when `expectedOid === currentOid` with `force: false`.
  - Any attempt to pass `force: true` is unconditionally rejected (`FORCE_UPDATE_FORBIDDEN`) in both the state-machine entrypoints and `createInMemoryWorkQueueRefStore`.
  - Any ref other than `refs/heads/work-queue` is rejected (`UNPROTECTED_WORK_QUEUE_REF`).
- **Unified scheduler & ownership moat (`planUnifiedWorkQueue` + `claimWorkQueueLease`)**:
  - Bridges `shadow-runtime.mjs` `plan()` task inputs (`enabled`, `stop`, `capacity`, `quotaVerified`, `tasks`) directly into `planner.mjs` (`planLanes`) and `project-config.mjs` lane ownership rules, validating `task.dependencies` and optional scheduling `policy` (including `policy.ready`) as non-proxy own-data structures prior to planning and snapshotting validated inputs/options before any async `refStore` read across claim, renewal, settlement, and reconciliation.
  - Prevents duplicate active claims for `(repositoryId, issueNumber)` and `(repositoryId, pullNumber, headSha)` (`DUPLICATE_ACTIVE_CLAIM`), compacts oldest terminal (`completed`/`cancelled`/`exhausted`) entries into a bounded `archivedTerminal` ledger (up to `2,000` keys without eviction; fails closed with `ARCHIVE_CAPACITY_EXHAUSTED` once full so completed/cancelled/exhausted work is never forgotten) when `entries` reaches `250`, reserves `QUEUE_CAPACITY_EXCEEDED` strictly for `250` active/queued non-terminal entries, rejects candidate `maxAttempts` exceeding `config.limits.maxAttempts` (`RETRY_CEILING_EXCEEDED`), and rejects any candidate whose `ownedPaths` overlap an active non-expired lease (`OWNED_PATHS_OVERLAP`) or reserved lane (`LANE_RESERVED`).
- **Bounded execution TTL & monotonic fencing (`renewWorkQueueLease`, `settleWorkQueueLease`)**:
  - Enforces `1..3,600,000 ms` (`MAX_LEASE_TTL_MS`) bounds on both `leaseTtlMs` and `maxExecutionMs`.
  - Computes an immutable per-claim `executionDeadlineMs = claimedAtMs + maxExecutionMs`. Renewals clamp `clampedExpiry = Math.min(executionDeadlineMs, nowMs + leaseTtlMs)`, advance `leaseExpiresAtMs = Math.max(entry.leaseExpiresAtMs, clampedExpiry)` monotonically within a generation (so out-of-order renewals never shorten an already-acknowledged expiry), and fail closed with `EXECUTION_TTL_EXCEEDED` once reached.
  - Every claim and orphan reclamation advances monotonic `nextGeneration`; stale workers presenting an older `generation` are fenced off with `STALE_GENERATION`.
- **GitHub run-state crash recovery (`reconcileWorkQueueRunStates`)**:
  - Rejects clock-skewed `nowMs < entry.claimedAtMs` fail-closed (`CLOCK_SKEW_REJECTED`) prior to evaluating any run transition or expiry.
  - Handles `launch_failed`, `worker_terminated`, `run_terminal` (with `conclusion`), `run_missing`, and TTL-expired leases (`lease_expired`).
  - Matches run observations against the active lease's exact `(runId, runAttempt, leaseGeneration)` tuple; stale or mismatched observations are recorded as `STALE_OR_INACTIVE_RUN` while still evaluating whether the entry's current active lease has expired.
  - Rejects terminal `'success'` completion once `nowMs >= leaseExpiresAtMs` (treating the lease as expired rather than completing an expired claim), clamps retry limits to `Math.min(entry.maxAttempts, config.limits.maxAttempts)`, deterministically bumps `generation`, transitions failed/terminated/missing/expired runs to `'requeued'` or `'exhausted'`, and records sanitized structured `recoveryReceipts`.
  - Honors emergency `stop === true` (`STOPPED`) prior to any state mutation.
  - **Cloudflare Durable Objects (Free plan)** remains strictly an owner-approved escalation option only if git-ref CAS contention ever warrants it; Temporal and LangGraph are excluded.
