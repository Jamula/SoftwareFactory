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

1. **Exact-input CI cache keys and anti-poisoning verification (`tools/engineering-factory/locked-build-cache.mjs`)**: `deriveCiCacheKeys` and `verifyCiCacheEntry` bind cache keys per OS RID (`linux-x64` and `win-x64`) for SoftwareFactory's three restore/build bottlenecks—`npm ci` (`package-lock.json` + Node.js `26.13.1`), NuGet/AppHost restore and build (`apphost.cs` + `global.json` + .NET SDK `10.0.404`), and `Aspire.Cli 17.0.0`. Fork or untrusted writer provenance, OS/toolchain drift, input digest mismatch, spoofed keys, tampered artifact digests, or unclean layouts fail closed, and `fullVerificationRequired: true` always holds.
2. **Repository-wide change-graph fast feedback (`tools/engineering-factory/contract-routing.mjs`)**: `softwareFactoryCatalog` and `planChangeGraphFastFeedback` map changes across `tools/engineering-factory`, `tools/engineering-coordinator`, `apphost.cs`, `.github/workflows`, `config`, `docs`, `agents`, `tests/*`, and root lock/governance files to deterministic fast-feedback test subsets while strictly preserving `fullValidationRequired: true` (`98%` line / `95%` branch coverage, security scanning, and Linux/Windows Aspire runtime gates).
3. **Deterministic failure diagnosis and bounded repair (`tools/engineering-factory/validation-diagnosis.mjs`)**: `classifyValidationFailure` separates `test`, `coverage`, `security`, `infra` / `runner-timeout`, `dependency-lock`, and `permission` signals into bounded actions, rejecting blind retries on deterministic failures (including non-transient stage or certificate timeouts) and capping transient runner retries at `retryLimit <= 2`.
