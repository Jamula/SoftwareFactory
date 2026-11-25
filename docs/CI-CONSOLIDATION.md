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
