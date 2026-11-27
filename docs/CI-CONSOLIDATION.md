# Consolidated CI migration (#4, #15, #16)

Phase 1: retain all existing check contexts; execute the twelve existing component-specific coverage commands and Aspire headless smoke in the existing Factory validation / build-test job. Preserve the core, runtime and CLI gates, full-suite Cobertura report, pinned checkout/runtime, and separate least-privilege publishing. No new job or service. The legacy checks deliberately overlap during migration.

Phase 2: after independent review, exact-head and merge-group success, and verified effective required-check configuration, remove only these thirteen redundant workflow files:
- `.github/workflows/budget-validation.yml`
- `.github/workflows/telemetry-validation.yml`
- `.github/workflows/review-history-validation.yml`
- `.github/workflows/contract-routing-validation.yml`
- `.github/workflows/event-envelope-validation.yml`
- `.github/workflows/lease-transition-validation.yml`
- `.github/workflows/integration-train-validation.yml`
- `.github/workflows/validation-diagnosis-validation.yml`
- `.github/workflows/stage-aggregate-validation.yml`
- `.github/workflows/coverage-evidence-validation.yml`
- `.github/workflows/dispatch-intent-validation.yml`
- `.github/workflows/pilot-readiness-validation.yml`
- `.github/workflows/aspire-smoke-validation.yml`

Replace any required legacy contexts with the verified consolidated build-test context (trusted GitHub Actions producer), preserving every existing independent review, merge queue, CodeQL, secret/dependency/security and other required gate. Verify the actual effective organization and repository rulesets and legacy branch protections; do not infer requirements from PR workflow lists. No deletion before this evidence. Keep coverage publishing separate. Keep pinned reusable smoke as a distinct integration contract check; it does not validate the current candidate. A failed reusable workflow must be investigated separately.

Measure wall-clock critical path and runner-job counts for comparable PR and merge-group runs. Removing thirteen standalone jobs does not guarantee proportional elapsed-time improvement. New production components must be added to the consolidated coverage gates; no coverage exclusions or lowered thresholds. Actual Windows/Aspire runtime and OTLP acceptance remain distinct from headless smoke. No consumer activation, deployment, or spending increase.

Owner update (Nov 25, 2026): SoftwareFactory enforces at least 98% source lines and 95% source branches for each executable component and overall. Existing consumer repository thresholds are unchanged. Keep consolidated check names and independent review/security gates intact.

Run the headless Aspire fixture under the Node test runner so its assertions and executable source are included in the fixture gate and the full coverage report. This measures the JavaScript fixture. The Windows AppHost and local OTLP acceptance still require runtime evidence.

## M02.01 locked CI cache, change-graph fast feedback, and bounded repair (#15)

To accelerate CI feedback and eliminate repeated cold restore overhead without weakening any gate, the pure evaluator components enforce three fail-closed contracts:

1. **Exact-input CI cache keys and anti-poisoning verification (`tools/engineering-factory/locked-build-cache.mjs`)**: `deriveCiCacheKeys` and `verifyCiCacheEntry` bind cache keys per OS RID (`linux-x64` and `win-x64`) for SoftwareFactory's three restore/build bottlenecks—`npm ci` (`package.json` + `package-lock.json` + `--ignore-scripts` + Node.js `26.13.1`), NuGet/AppHost restore and build (`apphost.cs` + `global.json` + `Release` build configuration + .NET SDK `10.0.404`), and `Aspire.Cli 17.0.0`. Fork or untrusted writer provenance, OS/toolchain/install-flag/build-configuration drift, input digest mismatch, spoofed keys, tampered artifact digests, or unclean layouts fail closed, and `fullVerificationRequired: true` always holds.
2. **Repository-wide change-graph fast feedback (`tools/engineering-factory/contract-routing.mjs`)**: `softwareFactoryCatalog` and `planChangeGraphFastFeedback` map changes across `tools/engineering-factory`, `tools/engineering-coordinator` (propagating into `engineering-factory` and `apphost-runtime`), `apphost.cs`, `.github/workflows`, `config`, `docs`, `agents`, `tests/*`, and root lock/governance files to deterministic fast-feedback test subsets reconciled against the candidate-head `testInventory` (handling suite additions, renames, and deletions while blocking on misaligned inventories) and strictly preserving `fullValidationRequired: true` (`98%` line / `95%` branch coverage, security scanning, and Linux/Windows Aspire runtime gates).
3. **Deterministic failure diagnosis and bounded repair (`tools/engineering-factory/validation-diagnosis.mjs`)**: `classifyValidationFailure` separates `test`, `coverage` (`add-targeted-coverage-tests` for threshold deficits vs. `diagnose-coverage-evidence` for missing/head-mismatched reports), `security`, `infra` / `runner-timeout`, `dependency-lock`, and `permission` signals into bounded actions, rejecting blind retries on deterministic failures (including non-transient stage or certificate timeouts) and capping transient runner retries at `retryLimit <= 2`.
4. **12-to-8 check-consolidation parity verifier (`evaluateCheckConsolidationParity` in `tools/engineering-factory/ci-stage-benchmark.mjs`)**: classifies every baseline and proposed check into `required-execution` (real validation jobs, including `test-coverage` and `linux-aspire-runtime` consolidated under `build-test`), `reporting` (native coverage publishing and duplicate Code Quality status contexts), or `disabled-shadow-inventory` (`Factory shadow reconciliation / inventory` when `FACTORY_SHADOW_ENABLED != 'true'`). Consolidation to `<= 8` meaningful checks (`defaultSoftwareFactoryConsolidationProposal()` maps 12 meaningful baseline checks—9 `required-execution` and 3 `reporting`—plus 1 disabled shadow inventory check to 8 meaningful checks plus 1 preserved shadow inventory check) fails closed if any proposal:
   - drops, downgrades, or omits explicit platform/trusted-producer metadata on `build-test` (`linux`), `upload-coverage-javascript` (`linux`), `windows-aspire-runtime` (`windows`), `.NET MAF specialist agents` (explicit `linux` + `windows` parity), or `CodeQL` (`linux`);
   - drops organization/repository secret scanning, `merge_group` check coverage, independent exact-head review, `>=98%` line / `>=95%` branch coverage thresholds, or affirmative `nativeCoverageIntegrated` / `equivalentVerificationProven` / `shadowEventIngestionPreserved` prerequisites;
   - deletes, promotes, disguises, or drops baseline event listeners from `disabled-shadow-inventory` event-reconciliation checks to manufacture check-count reductions; or
   - removes or narrows any baseline check without verified `consolidatedInto` equivalence across trusted producers, OS platforms, and every baseline trigger.
5. **Exact-input NuGet package caching and stage telemetry (`.github/workflows/dotnet-agents.yml`)**: `linux-dotnet-agents` (`ubuntu-latest`) and `windows-dotnet-agents` (`windows-latest`) isolate `NUGET_PACKAGES` under `$RUNNER_TEMP/nuget-packages`, restore packages read-only via SHA-pinned `actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9` (`v6.1.0`) on `pull_request` and `merge_group` with zero `restore-keys` prefix fallback, write caches via `actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9` (`v6.1.0`) strictly on protected `push` to `refs/heads/main` in `Jamula/SoftwareFactory` (`1471342715`), preserve `permissions: contents: read` and Coverlet `98%/95%` gates, and emit structured per-stage millisecond timings (`restore_ms`, `build_ms`, `test_coverage_ms`, `smoke_ms`) with zero `${{ ... }}` script interpolation.
