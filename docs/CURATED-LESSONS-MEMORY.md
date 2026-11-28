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

`evaluateMeasuredRepositoryExplorationCohort(input)` binds real merged GitHub pull request metadata and exact-HEAD Actions `coverage-evidence.json` telemetry directly to `selectScopedGuidanceAndLessons`:

- **Causal non-leakage & window comparability:** Enforces equal-duration, non-overlapping `[startMs, endMs]` windows (`candidateWindow.endMs <= nowMs`), requires every `mergedAtMs` to fall within its cohort window and every candidate PR `createdAtMs >= candidateWindow.startMs` (`PR_OUTSIDE_COHORT_WINDOW`, excluding pre-guidance PRs opened before the candidate window), and rejects any curated lesson observed after `candidateWindow.startMs` (`CAUSAL_LESSON_LEAKAGE`).
- **Independent per-component & pooled overall coverage gates:** Each PR retains `componentCoverages` rows (`{component, coveredLines, totalLines, coveredBranches, totalBranches}`); every component is validated independently against `policy` (`>= 98%` lines / `>= 95%` branches or stricter consumer floors) before pooling, and both pooled component counts and pooled `overall` repository counts are compared using exact `BigInt` cross-products (`COVERAGE_REGRESSED`).
- **Strict separation of projected savings & interaction proxies from live adoption gates:**
  - `projectedSelectorSavings` (`fullCatalogBytes` vs. `selectedContextBytes`) is reported separately (`advisoryOnly: true`) unless every PR supplies repository-bound `contextLoadObservation` (`UNVERIFIED_CONTEXT_LOADING_TELEMETRY`).
  - `interactionTurnMetrics` (`totalCommits + reviewCount`) is reported separately (`advisoryProxyOnly: true`) and never assigned to `aiCredits` or compared against `quotaCreditsRemaining`; quota and AI-credit cost gates require explicit `verifiedAiCredits` on every PR (`UNVERIFIED_AI_CREDIT_ACCOUNTING`).
  - `revisedExitContract` enforces `preservesM01Issue10DirectCopilotGate === true` (`M01_ISSUE_10_GATE_WEAKENING_FORBIDDEN`) and `livePolicyAdoptionAuthorized === false` (`LIVE_POLICY_ADOPTION_OVERRIDE_FORBIDDEN`) so sub-agent wave readouts never bypass `ADOPTION_APPROVED` live gates or `M01` (`#10`) direct `@copilot` exit requirements.

### Measured `Jamula/SoftwareFactory` Receipt (`docs/evidence/m02-03-curated-lessons-cohort.json`)

- **Provenance & replacement exit contract:** Recorded on `main` commit `1c587c3ba4ef4506c15aa1fe0561c369f1fdc008` (`executionSurface: "copilot-subagent-wave-prs"`, `unattendedCopilotBotClaimed: false`, `livePolicyAdoptionAuthorized: false`, `issueClosureAuthorized: true` for `#14` under the owner-approved Nov 28, 2026 Wave 6 `revisedExitContract`, while `M01` `#10`'s 3 direct `@copilot` outcomes remain independently required).
- **Offline/shadow selector replay (`cohortComparison`):** `5` matched replay units evaluated by `compareExplorationContextReduction` -> **`ADOPTION_APPROVED`** (`contextBytesLoadedP50: 1336 -> 215` bytes, `-83.91%`; `explorationStepsP50: 14 -> 6`; `reworkIterationsRateBps: 8000 -> 2000`; `$0` incremental billed spend).
- **Historical Wave 3/4 (`02:30:00Z–05:30:00Z`: `#167`, `#160`, `#157`, `#147`, `#168`) vs. Wave 5 (`05:30:00Z–08:30:00Z`: `#171`, `#172`, `#173`, `#174`, `#177`) repository readout (`measuredRepositoryCohort`):**
  - **Observed PR rework & review reductions:** `reworkIterationsRateBps` reduced **`52,000 -> 12,000` bps** (`-40,000` bps / `-76.92%`, `26 -> 6` post-initial commits), `repeatedContextLoadsP50` reduced **`5 -> 1`** (`-80.00%`), `explorationStepsP50` (`uniqueReviewedCommits + reviewComments`) reduced **`19 -> 5`** (`-73.68%`), and separate `interactionTurnMetrics` reduced **`22.6 -> 6.6` turns/PR** at `$0` incremental billed spend.
  - **Exact-HEAD CI coverage & fail-closed live adoption status:** Modified-component coverage improved **`99.89%` lines / `98.76%` branches -> `99.97%` lines / `99.67%` branches** and pooled overall branch coverage improved **`99.06% -> 99.12%`**, while pooled overall line coverage across Wave 3->Wave 5 base expansion shifted **`99.9438% -> 99.9312%`** (inherited from Wave 4 `PR #168`'s `41,787 / 41,816` `ec438f5` base; Wave 5 exceeded `#168`'s `99.93065%` handoff base). Consequently, `evaluateMeasuredRepositoryExplorationCohort` records `status: "REJECTED_REGRESSION"` (`rejectionReasons: ["COVERAGE_REGRESSED"]`, `unverifiedTelemetryReasons: ["UNVERIFIED_CONTEXT_LOADING_TELEMETRY", "UNVERIFIED_AI_CREDIT_ACCOUNTING"]`, `adoptionApproved: false`, `issue14ReadoutClosureAuthorized: true`), withholding live policy adoption while completing `#14`'s readout deliverable.

## Verification

```bash
node --test tests/engineering-factory/curated-lessons.test.mjs
npm run test:coverage
dotnet test
```
