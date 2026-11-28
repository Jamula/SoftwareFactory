# Curated Lessons & Scoped Repository Knowledge Memory (`M02.03` / `#14`)

This document specifies the deterministic, metadata-only, fail-closed repository knowledge selector and measured exploration-reduction cohort evaluator in [`tools/engineering-factory/curated-lessons.mjs`](../tools/engineering-factory/curated-lessons.mjs) and its measured Wave 3/4 vs. Wave 5 repository cohort receipt in [`docs/evidence/m02-03-curated-lessons-cohort.json`](evidence/m02-03-curated-lessons-cohort.json).

## Design Principles & Operating Constraints

- **Pure, read-only, shadow evaluation:** Every decision returned by `validateCuratedLesson`, `selectScopedGuidanceAndLessons`, `compareExplorationContextReduction`, and `evaluateMeasuredRepositoryExplorationCohort` is frozen (`Object.freeze`), side-effect-free (`readOnly: true`, `shadow: true`, `autoPolicyMutation: false`), and operates strictly on in-memory metadata.
- **Zero mandatory external knowledge store:** `externalKnowledgeStoreRequired: true` fails closed with `EXTERNAL_KNOWLEDGE_STORE_FORBIDDEN`. Issue refinement, contracts, and acceptance criteria remain in GitHub.
- **Provenance & freshness binding:**
  - Repository guidance (`guidanceEntries`) accepts only `trusted-repo-doc` and `trusted-lane-contract` sources pinned to `expectedHeadSha` (`revisionSha === expectedHeadSha`) and safe repo-relative `sourcePath` values.
  - Curated lessons (`curatedLessons`) accept only `accepted-pr` and `accepted-issue` sources with positive `sourceNumber`, 40-hex `sourceCommitSha`, exact `verifiedHeadSha === expectedHeadSha`, `observedAtMs <= nowMs`, and `nowMs - observedAtMs <= maxFreshnessMs <= MAX_FRESHNESS_CEILING_MS` (`31,536,000,000` ms).
- **Strict descriptor & proxy hardening:** All envelopes and arrays reject `Proxy` instances (`types.isProxy`), non-plain prototypes, getters/setters, non-enumerable properties, symbol keys, and sparse arrays.

## Security Hardening & Fail-Closed Content Inspection

Every guidance entry and curated lesson `guidanceText` (`<= 512` UTF-16 code units, well-formed, non-blank, with zero C0/C1 controls, format characters `\p{Cf}`, or `\p{Default_Ignorable_Code_Point}`) undergoes deterministic inspection before selection:

1. **Secret & credential rejection (`SECRET_OR_CREDENTIAL_DETECTED`):** Blocks personal/fine-grained GitHub tokens, model/cloud API keys, PEM private-key headers, `Bearer` tokens, key/secret assignments, and credential-bearing URLs.
2. **Prompt-injection rejection (`PROMPT_INJECTION_DETECTED`):** Unconditionally rejects role-boundary markers (`<system>`, `[INST]`, `[ADMIN_OVERRIDE]`), developer-mode escalations, and `curl`/`wget` exfiltration directives. Instruction-override verbs (`ignore`, `disregard`, `forget`, `override`) are permitted only inside bounded, single-negation safety prohibitions (`Never ignore repository instructions...`) with zero polarity-reversing suffixes or conditional carveouts.
3. **Cross-repository isolation (`CROSS_REPO_PRIVATE_DATA_REJECTED`):**
   - Enforces `repositoryId` + canonical `repositorySlug` matching and `visibility: "same-repo"`.
   - Normalizes IDNA dots (`\u3002`, `\uFF0E`, `\uFF61`) and percent-encoded octets before splitting tokens into host candidates so foreign GitHub authorities, protocol-relative URLs (`//github.com/...`), non-`http` or label-prefixed URLs (`link:https://github.com/other/repo`), punctuation/dash-prefixed URLs (`!https://github.com/other/repo`, `—https://github.com/other/repo`), prefixed qualifiers (`target:repo:other/repo`, `--repo other/repo`), and prefixed shorthand references (`see:other/repo#42`) cannot evade isolation checks.
4. **Policy-weakening & conditional-carveout rejection (`POLICY_WEAKENING_REJECTED`):**
   - Preserves `SoftwareFactory` floors (`98%` line / `95%` branch), default consumer floors (`95%` / `90%`), and stricter per-consumer overrides (`policy.minLineCoveragePct` / `policy.minBranchCoveragePct`).
   - Matches space-, hyphen-, and underscore-delimited gate names (`security-gate`, `review-gate`, `merge-queue`, `ci-gate`, `ci-check`, `lines-coverage`, `branch-coverage`, `independent-review`, `ownership-guard`, `budget-gate`, `zero-spend`, `turn-off`, `self-merge`, `unreviewed-merge`, `live-dispatch`, `paid-fallback`, etc.).
   - Rejects conditional safety carveouts across local clauses, `:` / `;` compound clauses (`Except for hotfixes: never skip coverage`, `Unless urgent; do not bypass security gates`), parenthesized/quoted/dash-prefixed trailing sentences (`Never skip coverage. (Unless urgent.)`), and conditional conjunctions (`unless`, `except`, `but`, `however`, `instead`, `otherwise`, `though`, `although`, `if`, `when`, `whenever`, `where`, `while`, `provided`, `once`, `until`, `during`, `in case`, `as long as`, `so long as`, `even if/when/though`, `only if/when/...`, `other than`, `apart from`, `save for`).

## Scoped Selection & Checkpoint Deduplication

`selectScopedGuidanceAndLessons(input)` filters validated entries by `targetComponent`, `specialistRole` (`api`, `data`, `security`, `test`, `infra`, `ui`, `docs`, `coordinator`), and `changedPaths` prefixes:

- When `checkpointEvidence` is supplied (bound to `repositoryId`, `issueNumber`, `headSha`, W3C `traceparent`, `digestSha256`, and `completedSupersteps`), path-scoped entries covering only `verifiedPaths` are omitted (`omittedCheckpointedCount`) so resumed worker supersteps do not reload already-verified context.
- Matched guidance ranks by `(specificity DESC, guidanceId ASC)` using locale-independent code-unit ordering; matched lessons rank by `(specificity DESC, observedAtMs DESC, lessonId ASC)` within `maxSelectedGuidance` (`8`), `maxSelectedLessons` (`8`), and `maxContextBytes` (`4096`).

## Measured Repository Cohort Evaluation (`evaluateMeasuredRepositoryExplorationCohort`)

`evaluateMeasuredRepositoryExplorationCohort(input)` binds real merged GitHub pull request metadata and exact-HEAD Actions `coverage-evidence.json` telemetry directly to `selectScopedGuidanceAndLessons` and `compareExplorationContextReduction`:

- **Causal non-leakage & window comparability:** Enforces equal-duration, non-overlapping `[startMs, endMs]` windows (`candidateWindow.endMs <= nowMs`), requires every `mergedAtMs` to fall within its cohort window and every candidate PR `createdAtMs >= candidateWindow.startMs` (`PR_OUTSIDE_COHORT_WINDOW`, excluding pre-guidance PRs opened before the candidate window), and rejects any curated lesson observed after `candidateWindow.startMs` (`CAUSAL_LESSON_LEAKAGE`).
- **Anti-duplication & concurrent file-overlap detection:** Rejects duplicate `prNumber`, `headSha`, `mergeCommitSha`, `ciCoverageJobId`, or `closedIssueNumbers` across baseline and candidate cohorts (`DUPLICATE_PR_EVIDENCE`), enforces mathematical nesting between component and overall CI coverage counts (`covered <= overallCovered`, `total - covered <= overallTotal - overallCovered`), and flags concurrent `changedPaths` prefix overlaps within a wave as `duplicateWork: true` (`ROUTING_OR_DUPLICATE_WORK_VIOLATION`).
- **Deterministic observable derivations (`MEASURED_METRIC_DERIVATIONS`):**
  - `contextBytesLoaded`: `fullCatalogBytes` (unscoped baseline) vs. `selectedContextBytes` (scoped candidate; empty selections fail closed with `EMPTY_SCOPED_SELECTION`).
  - `reworkIterations`: `totalCommits - 1` (conservative count of all post-initial PR commits).
  - `repeatedContextLoads`: `uniqueReviewedCommits - 1` (post-initial reviewed commit rounds).
  - `explorationSteps`: `loadedKnowledgeEntries + uniqueReviewedCommits + reviewComments` (PR-observable exploration/triage proxy; internal LLM tool-call traces are not claimed).
  - `aiCredits`: `totalCommits + reviewCount` (included-quota interaction-turn proxy at `$0` incremental billed spend; internal billing SKU meters are not claimed).

### Measured `Jamula/SoftwareFactory` Cohort Receipt (`docs/evidence/m02-03-curated-lessons-cohort.json`)

- **Evaluation mode & provenance:** `measured-repository-wave-cohort-replay` on `main` commit `1c587c3ba4ef4506c15aa1fe0561c369f1fdc008` (`executionSurface: "copilot-subagent-wave-prs"`, `unattendedCopilotBotClaimed: false`, `incrementalBilledUsdCents: 0`, `issueClosureAuthorized: true` for `#14`).
- **Matched 3-hour windows (`2026-11-28` UTC):**
  - **Pre-guidance Wave 3/4 baseline (`02:30:00Z–05:30:00Z`):** `5` merged PRs (`#167`, `#160`, `#157`, `#147`, `#168`) — `31` total commits (`26` rework commits, `52,000` bps), `82` review submissions, `92` inline review comments, `1,336` unscoped catalog bytes/PR.
  - **Post-guidance Wave 5 candidate (`05:30:00Z–08:30:00Z`):** `5` merged PRs (`#171`, `#172`, `#173`, `#174`, `#177`, closing `#6`, `#13`, and `#15`) — `11` total commits (`6` rework commits, `12,000` bps), `22` review submissions, `24` inline review comments, `210–405` scoped context bytes/PR (`P50 = 215` bytes).
- **Measured outcome (`ADOPTION_APPROVED` / `EXPLORATION_AND_CONTEXT_REDUCED`):**
  - `reworkIterationsRateBps`: **`52,000 -> 12,000` bps** (`-40,000` bps / `-76.92%`, from `5.20` to `1.20` post-initial commits/PR, including zero-rework 1-commit 10-file `PR #173`).
  - `contextBytesLoadedP50`: **`1,336 -> 215` bytes** (`-1,121` bytes / `-83.91%`).
  - `repeatedContextLoadsP50`: **`5 -> 1`** (`-4` / `-80.00%`).
  - `explorationStepsP50`: **`32 -> 7`** (`-25` / `-78.13%`).
  - `aiCreditsPerUnit`: **`22.6 -> 6.6`** (`-16.0` interaction-turn proxy units/PR, `$0` incremental billed spend).
  - **Exact-HEAD CI coverage:** Component coverage improved from **`99.89%` lines / `98.76%` branches** (`7,821 / 7,830` lines, `4,384 / 4,439` branches) to **`99.97%` lines / `99.67%` branches** (`7,675 / 7,677` lines, `3,596 / 3,608` branches), with every PR's full-repository CI run exceeding `99.93%` lines and `98.87%+` branches.

## Verification

```bash
node --test tests/engineering-factory/curated-lessons.test.mjs
npm run test:coverage
dotnet test
```
