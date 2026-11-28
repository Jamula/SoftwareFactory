# Curated Lessons & Scoped Repository Knowledge Memory (`M02.03` / `#14`)

This document specifies the deterministic, metadata-only, fail-closed repository knowledge selector and exploration-reduction cohort gate in [`tools/engineering-factory/curated-lessons.mjs`](../tools/engineering-factory/curated-lessons.mjs) and its offline shadow cohort receipt in [`docs/evidence/m02-03-curated-lessons-cohort.json`](evidence/m02-03-curated-lessons-cohort.json).

## Design Principles & Operating Constraints

- **Pure, read-only, shadow evaluation:** Every decision returned by `validateCuratedLesson`, `selectScopedGuidanceAndLessons`, and `compareExplorationContextReduction` is frozen (`Object.freeze`), side-effect-free (`readOnly: true`, `shadow: true`, `autoPolicyMutation: false`), and operates strictly on in-memory metadata.
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

## Matched `>= 5`-Unit Exploration & Context-Reduction Cohort Receipt

`compareExplorationContextReduction(baselineCohort, candidateCohort, policy)` requires non-overlapping, equal-duration windows with `>= 5` accepted units (`MIN_COMPARABLE_COHORT_UNITS = 5`), `provenanceVerified: true`, `independentReviewVerified: true`, verified `quotaCreditsRemaining`, `$0` incremental spend (`incrementalBilledUsdCents === 0`), zero coverage/security/routing/duplicate-work/throughput/cost/exploration/rework regressions, and material improvement in exploration steps P50, context bytes P50, repeated context loads P50, or rework rate.

### Provenance Boundary (`docs/evidence/m02-03-curated-lessons-cohort.json`)

- **Evaluation mode:** `offline-shadow-replay` (`liveAutonomyClaim: false`, `liveCopilotCohortProvenance: false`, `issueClosureAuthorized: false`).
- **Cohort scope:** `6` matched units (`m02-03-unit-01` through `m02-03-unit-06`) anchored to verified `Jamula/SoftwareFactory` merged PR commits (`#157`, `#160`, `#161`, `#164`, `#166`, `#169`) on `main` commit `ec438f54088f30856c2df6ff626e894dde2a0100`.
- **Measured offline shadow outcome:** `ADOPTION_APPROVED` (`EXPLORATION_AND_CONTEXT_REDUCED`) — `explorationStepsP50` reduced `14 -> 6` (`-8`), `contextBytesLoadedP50` reduced `1249 -> 217` bytes (`-1032`), `repeatedContextLoadsP50` reduced `4 -> 1` (`-3`), `reworkIterationsRateBps` reduced `6667 -> 1667` (`-5000`), `aiCreditsPerUnit` reduced `20 -> 15` (`-5`, `$0` incremental spend), with `99.4%` line and `98.0%` branch coverage.
- **Live milestone status:** Issue `#14` remains open pending the shared `5`-issue real `@copilot` cohort tracked under the streamlined `M02` exit plan.

## Verification

```bash
node --test tests/engineering-factory/curated-lessons.test.mjs
npm run test:coverage
```
