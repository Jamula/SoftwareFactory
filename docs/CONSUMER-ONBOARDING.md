# Onboard a consumer repository

The integration model is shared code with independently pinned, repository-local configuration. Today only offline contract verification and synthetic replay are available; do not activate live controller behavior.

![Target shared engine and isolated consumers](images/architecture.svg)

## Lightweight read-only onboarding planner (`<= 5` mandatory settings)

`buildReadOnlyOnboardingPlan(discoveryInput)` in `tools/engineering-factory/consumer-onboarding.mjs` implements Customer One's deterministic, metadata-only onboarding planner for both `"greenfield"` and `"existing-repository"` modes without live GitHub mutations, repository creation, credentials, external services, or incremental spend (`$0`).

### Mandatory user-supplied settings ceiling (`MAX_MANDATORY_USER_SETTINGS = 5`)

Onboarding requires at most **4 mandatory user-supplied settings** plus **1 optional threshold override** (`<= 5` total; any request demanding `> 5` mandatory user inputs fails closed with `MANDATORY_SETTINGS_LIMIT_EXCEEDED`):

1. `repository`: Target `owner/repo` slug (never `Jamula/SoftwareFactory`).
2. `repositoryId`: Stable numeric GitHub repository ID (never `1471342715`).
3. `pinnedFactorySha`: Immutable 40-lowercase-hex commit SHA for `Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@<sha>`. Cataloged workflow revisions in `TRUSTED_WORKFLOW_CHECKOUT_PINS` (`afc3d223f287b029db32672908097efc67a259c9` → `1208481843e73d1d2506085c654e84255303541d`) automatically bind their verified internal `checkoutRef`; uncataloged workflow SHAs require explicit `observedCheckoutRef` + `pinnedCheckoutSha` evidence or fail closed (`CHECKOUT_PIN_UNVERIFIED` / `PIN_SHA_MISMATCH`).
4. `stackProfile`: Cataloged profile key (`baseline-95-90`, `web-genealogy-95-90`, `ios-webkit-97-90`, or `strict-up-to-date-migration-gated`).
5. `stricterCoverageThresholds` *(optional 5th setting)*: `{ line, branch }` raising local coverage above the consumer/profile/discovered floor (attempting to lower any existing or baseline gate fails closed with `BASELINE_COVERAGE_BELOW_MINIMUM` or `LOCAL_GATE_WEAKENED`).

### Greenfield vs. existing-repository workflow

- **Greenfield (`mode: "greenfield"`, default when `discoveredRepository` is omitted)**: Synthesizes a disabled-at-rest `.github/softwarefactory-policy.json` (`mode: "disabled"`, `killSwitch: true`), a SHA-pinned `.github/workflows/softwarefactory-shadow-replay.yml` (`permissions: contents: read`, `persistCredentials: false`), GitHub-Issues-authoritative tracking defaults (`separateBacklogCreated: false`, `mandatoryExternalServices: 0`), an independent per-repository kill switch, and a single-commit rollback plan (`single-commit-revert`).
- **Existing repository (`mode: "existing-repository"`)**: Combines the `<= 5` user settings with complete read-only `discoveredRepository` gate and file inventory (`defaultBranch`, `mergeMethod`, `checks`, `reviewers`, `owners`, `coverage`, `maxConcurrency`, `existingFiles`, plus optional `visibility`, `migrationFreezeClear`, `requireExplicitApproval`, `requireStrictUpToDate`, `allowCommentedBotApproval`; missing discovery fields block readiness with `DISCOVERY_INVENTORY_INCOMPLETE` and explicit `blockers`). Preserves all stricter existing consumer and profile gates—such as `97%/90%` line/branch coverage and `>= 2` platform checks on `ios-webkit-97-90`, `100%/100%` + locked `trunk`/`merge` + migration-freeze enforcement on `strict-up-to-date-migration-gated` (`LOCAL_GATE_WEAKENED` on conflict), stricter concurrency caps (`Math.min(profile.maxActive, maxConcurrency)`), and formal `APPROVED`-only independent reviews (`allowCommentedBotApproval: false`).
- **Read-only safety defaults & zero overwrites**: Enforces `defaultEnabled: false`, `implicitActivation: false`, `overwriteExistingFiles: false`, `liveMutations: 0`, and `deployments: 0`. Any override attempt fails closed (`UNSAFE_DISCOVERY_DEFAULTS`), unsupported external resources fail closed (`UNSUPPORTED_RESOURCE_BLOCKED`), and any collision with existing consumer files (exact, case-variant, ancestor, or descendant path) fails closed with `EXISTING_FILE_CONFLICT`.
- **Hosted execution options & AI Credit hard-stops**: Reports repository-visibility-aware execution capabilities (`gh-aw` + Copilot Cloud Agent + pinned `@microsoft/copilot-sdk` `2.0.3` on `public`, `private`, and `internal` repositories; Copilot Cloud Automations on `private` and `internal` repositories only) alongside mandatory per-repository `$0` paid-overage AI Credit hard-stops (`perRepoAiCreditHardStopRequired: true`, `paidOverageAllowed: false`).

```js
import { buildReadOnlyOnboardingPlan } from './tools/engineering-factory/consumer-onboarding.mjs';

// 1. Greenfield onboarding (4 mandatory settings; cataloged workflow SHA binds checkoutRef 12084818...)
const greenfieldPlan = buildReadOnlyOnboardingPlan({
  repository: 'example/new-project',
  repositoryId: 900501,
  pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9',
  stackProfile: 'baseline-95-90'
});

// 2. Existing repository onboarding with complete read-only gate & file inventory
const existingPlan = buildReadOnlyOnboardingPlan({
  mode: 'existing-repository',
  repository: 'example/spellbook',
  repositoryId: 900202,
  pinnedFactorySha: 'afc3d223f287b029db32672908097efc67a259c9',
  stackProfile: 'ios-webkit-97-90',
  stricterCoverageThresholds: { line: 98, branch: 92 },
  discoveredRepository: {
    defaultBranch: 'main',
    mergeMethod: 'squash',
    checks: [
      { name: 'fictional-webkit-gate', appId: 34567 },
      { name: 'fictional-ios-gate', appId: 34568 }
    ],
    reviewers: ['synthetic-spellbook-reviewer'],
    owners: [
      { prefix: 'ios/', owner: 'synthetic-ios-owner' },
      { prefix: 'src/', owner: 'synthetic-spellbook-owner' }
    ],
    coverage: { line: 97, branch: 90 },
    maxConcurrency: 2,
    existingFiles: ['.github/workflows/ios-ci.yml', 'src/bridge.ts']
  }
});
```

Measured synthetic verification (`tests/engineering-factory/consumer-onboarding.test.mjs`) executes both blank (`greenfield`) and existing (`existing-repository`) plans in `< 5 ms` (`<= 5 min` provisional target), emits `2` reviewable repository-local files, requires `4`–`5` user settings, records `0` live mutations/deployments and `$0` incremental spend, and proves single-commit/single-repository rollback without affecting peer consumers. Targets for live adoption remain provisional until M01 (#10) acceptance and separate owner authorization.

## Readiness checklist

1. **Verify authorization and freeze boundaries**: Confirm explicit owner authorization (`ownerAuthorized: true`), authoritative numeric `repositoryId` (never SoftwareFactory's `1471342715`), `autoActivate: false`, `productionDeployEnabled: false`, and no active migration freeze (`migrationFreezeClear: true`). Repository names never grant authorization.
2. **Inventory existing local gates**: Record `defaultBranch`, `mergeMethod`, exact required check `name` and trusted `appId` producers, independent reviewer identities, coverage gates (`>=95%` line / `>=90%` branch consumer floor, preserving any stricter existing gate) and `maxConcurrency`.
3. **Generate or author disabled local policy**: Use `buildReadOnlyOnboardingPlan` (lightweight `<= 5`-setting planner) or `planConsumerBootstrap` in `tools/engineering-factory/consumer-onboarding.mjs` for a dry-run, conflict-checked plan (`.github/workflows/softwarefactory-shadow-replay.yml` and `.github/softwarefactory-policy.json`). Stored onboarding policy must stay disabled at rest (`"mode": "disabled"`, `"killSwitch": true`); existing consumer files are never overwritten (`overwriteExistingFiles: false`).
4. **Pin immutable 40-hex commit SHAs**: Review both the called reusable workflow commit (`reviewedWorkflowSha`) and the internal evaluator checkout commit it references (`reviewedCheckoutSha`), pinning `Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@<40-hex-sha>` and verifying `checkoutRef` with `permissions: contents:read` and `persist-credentials: false`. Branch or tag refs (`@main`, `@v1.0.0`) and unreviewed or mismatched workflow/checkout SHAs are rejected by `verifyWorkflowPin` and `planConsumerBootstrap`.
5. **Isolate credentials per repository**: Scope shadow metadata access strictly to `[policy.repository]` (`scope: "repo-read-only-shadow"`, `sharedAdminToken: false`, `persistedInCheckout: false`) with a unique `credentialId` that is never shared across consumer repositories.
6. **Prove mandatory single-mutation shadow denials before review**: Verify the onboarding package with `verifyConsumerOnboardingPackage`, confirming `SHADOW_ELIGIBLE` for a valid candidate alongside single-field negative mutations and exact-reason denials for stale review (`REVIEW_MISSING`), dismissed review (`REVIEW_MISSING`), `COMMENTED` bot review (`REVIEW_MISSING`), wrong repository (`UNTRUSTED_POLICY`), missing quota (`BUDGET_OR_CONCURRENCY`) and active-shadow kill-switch stop (`STOPPED`).
7. **Verify independent single-repository rollback**: Prove via `verifyIndependentRollback` that setting `mode: "disabled"` and `killSwitch: true`, revoking only the target repository's `credentialId`, reverting the workflow SHA pin via a reviewed PR and confirming `queuedLiveMutations === 0` immediately stops the target repository (`STOPPED`) while peer consumers remain unaffected.

| Intended consumer | Offline synthetic profile (`example-policies.json`) | Policy and local gates to retain |
| --- | --- | --- |
| FamilyTree (#36, M03) | `example/family-tree` (`web-genealogy-95-90`) | Private-data isolation, `95%/90%` baseline coverage, `maxActive: 1`, `APPROVED`-only review and independent auth/persistence review |
| Spellbook (#11, M04) | `example/spellbook` (`ios-webkit-97-90`) | Stricter `97%` app line / `90%` branch gate, WebKit and iOS required check producers, `APPROVED`-only review and `maxActive: 2` concurrency cap |
| FamilyHub (#12, M05) | `example/family-hub` (`strict-up-to-date-migration-gated`) | Migration-freeze gate (`migrationFreezeClear` required), `trunk` strict up-to-date base, explicit exact-head `APPROVED` review and production isolation |
| Future repository | `baseline-95-90` or custom synthetic fixture | Explicit owner approval, unique `repositoryId` and `credentialId`, immutable 40-hex SHA pin, `>=95%/90%` or stricter local gates, included quota and independent single-commit rollback |

## Local contract verification

Run the synthetic profile and consumer onboarding contract suites locally without network or GitHub credentials:

```bash
node --test tests/engineering-factory/profiles.test.mjs tests/engineering-factory/consumer-onboarding.test.mjs
```

Actual check names, app IDs, repository IDs and permissions must be obtained by the owner from live repository settings after M01 (#10) acceptance and separate scoped authorization, never copied from fictional examples in `tools/engineering-factory/example-policies.json`. No adoption is currently activated. See [adoption contract](CONSUMER-ADOPTION-CONTRACT.md) and [workflow guide](WORKFLOWS.md).
