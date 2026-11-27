# Independent consumer adoption contract
Contributes to #13, #10, #36, #11, #12. Offline contract and synthetic verification only; no consumer is activated.

## Versioned onboarding contract (v1)
`tools/engineering-factory/consumer-onboarding.mjs` implements deterministic, pure, metadata-only contract verification (`verifyConsumerOnboardingPackage`, `verifyWorkflowPin`, `verifyIndependentRollback`, `planConsumerBootstrap`) backed by `validPolicy` and `evaluate` in `tools/engineering-factory/core.mjs`.

| Evidence | Required proof | Verifier enforcement |
|---|---|---|
| Repository identity | Authoritative stable numeric `repositoryId`, `owner/repo` slug, default branch, explicit owner enrollment (`ownerAuthorized: true`), migration-freeze clearance (`migrationFreezeClear: true`), `autoActivate: false`, `productionDeployEnabled: false` | Rejects `Jamula/SoftwareFactory` (`1471342715`), duplicate repositories/IDs, unauthorized names and frozen migrations (`ENROLLMENT_NOT_AUTHORIZED`, `INVALID_CONSUMER_POLICY`, `DUPLICATE_CONSUMER`) |
| Implementation & pin | Separate immutable 40-lowercase-hex SHAs on `Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@<sha>` (`reviewedWorkflowSha`) and internal `checkoutRef` (`reviewedCheckoutSha`), with `permissions: contents:read` and `persistCredentials: false` | Rejects branch/tag refs, short/uppercase SHAs, unreviewed or mismatched workflow/checkout SHAs and write/persisted credentials (`PIN_REF_NOT_IMMUTABLE_SHA`, `PIN_SHA_MISMATCH`, `PIN_PRIVILEGE_INVALID`) |
| Review | Independent exact-candidate `APPROVED` review, no unresolved threads, trusted check `appId` producers | Outside `Jamula/SoftwareFactory`, `COMMENTED` bot reviews (even allowlisted `copilot-pull-request-reviewer[bot]` with `summaryDisposition: "clear"`) fail closed with `REVIEW_MISSING` |
| Coverage & local gates | Consumer baseline minimum `>=95%` source-line and `>=90%` branch coverage per executable component and overall; SoftwareFactory itself requires `98%/95%`; stricter local gates (`minLineCoverage`, `minBranchCoverage`, `maxConcurrency`, `requiredChecks`, `requireExplicitApproval`, `requireStrictUpToDate`) always prevail | Stored onboarding policy must remain `mode: "disabled"` and `killSwitch: true`; lowering local coverage, raising `maxActive` above `maxConcurrency` or dropping a required check/producer fails closed (`BASELINE_COVERAGE_BELOW_MINIMUM`, `LOCAL_GATE_WEAKENED`, `SHADOW_POSTURE_REQUIRED`) |
| Capacity | Verified included quota and overage controls, repository-specific concurrency cap and kill switch | Missing/zero quota (`remainingCredits <= 0`) and tripped kill switch must fail closed in replay (`BUDGET_OR_CONCURRENCY`, `STOPPED`) |
| Access & isolation | Separate least-privilege `repo-read-only-shadow` credential scoped strictly to `[policy.repository]`; `sharedAdminToken: false`; `persistedInCheckout: false`; unique `credentialId` per repository | Rejects shared admin tokens, multi-repo scopes and cross-repository credential reuse (`CREDENTIAL_ISOLATION_VIOLATION`) |
| Reversibility | Disable enrollment (`mode: "disabled"`, `killSwitch: true`), revoke only the target repository's `credentialId`, revert workflow pin via reviewed PR and confirm `queuedLiveMutations === 0` | `verifyIndependentRollback` proves stopping one consumer leaves peer synthetic consumers unaffected (`SINGLE_REPO_ROLLBACK_VERIFIED`) |

## Component compatibility and provenance catalog
`CONSUMER_COMPONENT_CATALOG` enumerates the frozen, read-only factory surfaces reusable by consumers without copying consumer secrets or mutating GitHub:
- `evaluator-core` (`tools/engineering-factory/core.mjs`, v1): pure snapshot evaluator; zero network/GitHub I/O.
- `shadow-replay-workflow` (`.github/workflows/shadow-tests.yml`, v1): SHA-pinned `workflow_call` synthetic replay workflow with `contents: read` and `persist-credentials: false`.
- `consumer-onboarding-verifier` (`tools/engineering-factory/consumer-onboarding.mjs`, v1): offline onboarding package, isolation, rollback and dry-run bootstrap verifier.

## Independent pilot lanes
- **SoftwareFactory**: first demonstrate synthetic reusable workflow execution, trusted shadow evidence, expected-head safeguards and rollback (`>=98%` line / `>=95%` branch).
- **FamilyTree (M03, #36; consumer #128/#120)**: after M01 (#10) autonomous self-pilot acceptance, use synthetic data only (`example/family-tree` offline profile), retain `95%/90%` baseline, single-lane concurrency cap (`maxActive: 1`), `APPROVED`-only review and no product release. No duplicate core.
- **Spellbook (M04, #11; consumer #103)**: preserve stricter `97%` app line / `90%` branch coverage (`example/spellbook` offline profile), WebKit/iOS required check producers and current two-agent concurrency cap (`maxActive: 2`) until measured capacity approval.
- **FamilyHub (M05, #12; consumer #81)**: verify authoritative repository identity and owner migration-freeze lift separately (`migrationFreezeClear: true` required before clearance); preserve `trunk`/up-to-date enforcement, explicit exact-head `APPROVED` review and production isolation (`example/family-hub` offline profile). Development resumption is not factory activation authorization.

## Verification, dry-run bootstrap and negative fixtures
`tests/engineering-factory/profiles.test.mjs` and `tests/engineering-factory/consumer-onboarding.test.mjs` verify all three synthetic stack profiles (`example/family-tree`, `example/spellbook`, `example/family-hub` in `tools/engineering-factory/example-policies.json`, all stored at `mode: "disabled"` and `killSwitch: true`). Mandatory replay and verifier tests prove:
- Wrong repository identity (`UNTRUSTED_POLICY`), branch/tag or mismatched workflow/checkout SHA pins (`PIN_REF_NOT_IMMUTABLE_SHA`, `PIN_SHA_MISMATCH`), and missing check producer (`CHECKS_INCOMPLETE` / `LOCAL_GATE_WEAKENED`).
- Stale review, dismissed review and `COMMENTED` bot review denial outside `Jamula/SoftwareFactory` (`REVIEW_MISSING`).
- Exhausted or unknown quota (`BUDGET_OR_CONCURRENCY`), concurrency cap overflow, active migration freeze (`ENROLLMENT_NOT_AUTHORIZED`), cross-repo credential reuse (`CREDENTIAL_ISOLATION_VIOLATION`), kill-switch stop (`STOPPED`) and single-repository rollback without peer impact (`SINGLE_REPO_ROLLBACK_VERIFIED`).
- Conflict-safe dry-run bootstrap planning (`planConsumerBootstrap`) for blank and existing repositories: enforces `>=95/90` while preserving stricter existing gates, reruns idempotently (`IDEMPOTENT_NOOP`) and refuses to overwrite diverged files (`EXISTING_FILE_CONFLICT`).

Every unknown fails closed. Do not copy credentials, live policy from PR heads or private data. No live dispatch, merge, deployment or extra spending without separate verified authority.
