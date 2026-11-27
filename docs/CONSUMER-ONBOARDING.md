# Onboard a consumer repository

The integration model is shared code with independently pinned, repository-local configuration. Today only offline contract verification and synthetic replay are available; do not activate live controller behavior.

![Target shared engine and isolated consumers](images/architecture.svg)

## Desired onboarding experience (not yet implemented)

For a new project, the user describes an outcome and chooses the repository owner, project visibility and authorized AI/resources as needed. AI proposes the smallest viable project, initial GitHub issues, milestones, CI and a reviewable integration. For an existing repository, AI inventories the actual stack, existing issues, CI, protected branches, checks, security boundaries and authorized execution options; retain existing standards and do not duplicate tracking.

The initializer must support a read-only plan and safe repeat execution, detect conflicts without overwriting, generate minimal pinned repository-local configuration, produce a reviewable onboarding PR and report missing prerequisites. No credentials in prompts or committed configuration. Explicit owner authorization and verified included-only capacity are required before activation. Unsupported resources are reported as blocked; no mandatory hosted service, local installation or additional subscription.

Target <=5 mandatory user-provided settings (excluding explicit approval/credential entry), <=5 minutes for an initial plan and <=15 minutes for basic integration after prerequisites. Measure actual time, manual steps, generated files, and attributable cost on both a blank synthetic repository and an existing synthetic profile; then measure Customer One adoption separately. Targets are provisional. Use GitHub Issues/sub-issues and native dependency relationships; no separate spec or backlog. Existing projects keep independent pinned revisions, kill switches, and rollback.

## Readiness checklist

1. **Verify authorization and freeze boundaries**: Confirm explicit owner authorization (`ownerAuthorized: true`), authoritative numeric `repositoryId` (never SoftwareFactory's `1471342715`), `autoActivate: false`, `productionDeployEnabled: false`, and no active migration freeze (`migrationFreezeClear: true`). Repository names never grant authorization.
2. **Inventory existing local gates**: Record `defaultBranch`, `mergeMethod`, exact required check `name` and trusted `appId` producers, independent reviewer identities, coverage gates (`>=95%` line / `>=90%` branch consumer floor, preserving any stricter existing gate) and `maxConcurrency`.
3. **Generate or author disabled local policy**: Use `planConsumerBootstrap` in `tools/engineering-factory/consumer-onboarding.mjs` for a dry-run, conflict-checked plan (`.github/workflows/softwarefactory-shadow-replay.yml` and `.github/softwarefactory-policy.json`). Stored onboarding policy must stay disabled at rest (`"mode": "disabled"`, `"killSwitch": true`); reruns are idempotent and existing divergent files are never overwritten.
4. **Pin immutable 40-hex commit SHAs**: Review the SoftwareFactory commit and pin both `Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@<40-hex-sha>` and its `checkoutRef` to the exact `reviewedFactorySha` with `permissions: contents:read` and `persist-credentials: false`. Branch or tag refs (`@main`, `@v1.0.0`) and mismatched workflow/checkout SHAs are rejected by `verifyWorkflowPin`.
5. **Isolate credentials per repository**: Scope shadow metadata access strictly to `[policy.repository]` (`scope: "repo-read-only-shadow"`, `sharedAdminToken: false`, `persistedInCheckout: false`) with a unique `credentialId` that is never shared across consumer repositories.
6. **Prove mandatory shadow denials before review**: Verify the onboarding package with `verifyConsumerOnboardingPackage`, confirming `SHADOW_ELIGIBLE` for a valid candidate alongside exact-reason denials for stale review (`REVIEW_MISSING`), dismissed review (`REVIEW_MISSING`), `COMMENTED` bot review (`REVIEW_MISSING`), wrong repository (`UNTRUSTED_POLICY`), missing quota (`BUDGET_OR_CONCURRENCY`) and kill-switch stop (`STOPPED`).
7. **Verify independent single-repository rollback**: Prove via `verifyIndependentRollback` that setting `mode: "disabled"` and `killSwitch: true`, revoking only the target repository's `credentialId`, reverting the workflow SHA pin via a reviewed PR and confirming `queuedLiveMutations === 0` immediately stops the target repository (`STOPPED`) while peer consumers remain unaffected.

| Intended consumer | Offline synthetic profile (`example-policies.json`) | Policy and local gates to retain |
| --- | --- | --- |
| FamilyTree (#36, M03) | `example/family-tree` (`web-genealogy-95-90`) | Private-data isolation, `95%/90%` baseline coverage, `maxActive: 1`, `APPROVED`-only review and independent auth/persistence review |
| Spellbook (#11, M04) | `example/spellbook` (`ios-webkit-97-90`) | Stricter `97%` app line / `90%` branch gate, WebKit and iOS required check producers, `APPROVED`-only review and `maxActive: 2` concurrency cap |
| FamilyHub (#12, M05) | `example/family-hub` (`strict-up-to-date-migration-gated`) | Migration-freeze gate (`migrationFreezeClear` required), `trunk` strict up-to-date base, explicit exact-head `APPROVED` review and production isolation |
| Future repository | Custom synthetic fixture | Explicit owner approval, unique `repositoryId` and `credentialId`, immutable 40-hex SHA pin, `>=95%/90%` or stricter local gates, included quota and independent rollback |

## Local contract verification

Run the synthetic profile and consumer onboarding contract suites locally without network or GitHub credentials:

```bash
node --test tests/engineering-factory/profiles.test.mjs tests/engineering-factory/consumer-onboarding.test.mjs
```

Actual check names, app IDs, repository IDs and permissions must be obtained by the owner from live repository settings after M01 (#10) acceptance and separate scoped authorization, never copied from fictional examples in `tools/engineering-factory/example-policies.json`. No adoption is currently activated. See [adoption contract](CONSUMER-ADOPTION-CONTRACT.md) and [workflow guide](WORKFLOWS.md).
