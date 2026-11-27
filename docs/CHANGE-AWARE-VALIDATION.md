# Change-aware validation candidates

The evaluator exposes pure, offline, shadow-only metadata helpers for repository-wide change-graph fast feedback, exact-input CI cache derivation/verification, bounded validation failure repair, and synthetic integration-train comparison. They do not modify workflow selection, execute tests, read or write a cache, retry jobs, or approve integration.

## Fast feedback and repository change graph

`planFastFeedback` accepts a complete path inventory only when its repository, candidate head, base revision, and `trusted-ci` producer marker match the expected snapshot and the evidence is marked verified. The component catalog must name the same repository and base revision, have non-overlapping ownership roots, and provide valid dependency edges and test paths. Missing, stale, incomplete, ambiguous, or unmapped evidence blocks the suggestion.

`softwareFactoryCatalog` and `planChangeGraphFastFeedback` in `tools/engineering-factory/contract-routing.mjs` expand change-graph fast-feedback selection across all `Jamula/SoftwareFactory` repository paths:
- `tools/engineering-factory` and `tests/engineering-factory` (including direct `<stem>.mjs` to `<stem>.test.mjs` pairing and dependent `apphost-runtime` checks)
- `tools/engineering-coordinator` and `tests/engineering-coordinator`
- `apphost.cs` (plus `global.json` and `aspire.config.json`)
- `.github/workflows` (plus `apphost.run.json`)
- `config` and `agents` (propagating to dependent `engineering-coordinator` lanes)
- `docs` and root governance files (`README.md`, `SECURITY.md`, `AGENTS.md`, `CONTRIBUTING.md`, `LICENSE`, `NOTICE`, `VERSION`, `.gitignore`)
- `package.json` and `package-lock.json`

Every mapped or blocked result strictly preserves `fullValidationRequired: true`, `requiredValidation: 'full'`, `skipRequiredChecks: false`, and mandatory required gates (`98%` line coverage, `95%` branch coverage, security checks, and Linux/Windows runtime verification). Unmapped, incomplete, duplicate, or untrusted change inventories fail closed.

The `trusted-ci` marker is a data contract, not an authentication mechanism. A protected workflow adapter must bind it to authoritative GitHub metadata before supplying the evidence.

## Locked CI cache derivation and anti-poisoning verification

`planBuildReuse` in `tools/engineering-factory/validation-diagnosis.mjs` returns a candidate only when a verified `trusted-ci` receipt matches the repository, source head, workflow, dependency, toolchain, and input digests.

`hashLockedContent`, `deriveCiCacheKeys`, and `verifyCiCacheEntry` in `tools/engineering-factory/locked-build-cache.mjs` model exact-input cache keys and fail-closed verification for SoftwareFactory's three hosted CI restore/build bottlenecks per OS RID (`linux-x64` and `win-x64`):
- **`npmCi`**: `package-lock.json` SHA-256 digest + Node.js `26.13.1`
- **`nugetApphost`**: `apphost.cs` + `global.json` SHA-256 digests + .NET SDK `10.0.404`
- **`aspireCli`**: `Aspire.Cli 17.0.0` tool binary + .NET SDK `10.0.404` + pinned NuGet v3 feed per OS RID (`linux-x64` / `win-x64`)

`deriveCiCacheKeys` and `verifyCiCacheEntry` fail closed on fork or untrusted writer provenance (`isFork !== false`, `writerIsFork !== false`, `writerBranchProtected !== true`), OS or toolchain version drift, input digest mismatch, or cache poisoning (spoofed cache key, tampered observed artifact digest vs. expected writer receipt digest, or unclean archive layout). Even when an entry is verified (`verified: true`, `candidate: true`), `fullVerificationRequired: true` and `skipRequiredChecks: false` remain mandatory.

## Deterministic failure classification and bounded repair

`classifyValidationFailure` in `tools/engineering-factory/validation-diagnosis.mjs` deterministically classifies exact-head `trusted-ci` failure signals across six operational categories:
- `test` (`test-failure`, `assertion-failed`, `runtime-smoke-failed`) -> `repair-code-or-test`
- `coverage` (`coverage-below-target`, `coverage-missing`, `coverage-head-mismatch`) -> `add-targeted-coverage-tests`
- `security` (`codeql-alert`, `secret-detected`, `untrusted-provenance`, `cache-poisoning`, `tls-or-certificate`) -> `block-and-security-remediate`
- `infra` / `runner-timeout` (`runner-timeout`, `runner-lost`, `github-api-5xx`, `network-reset` when transient vs. deterministic `job-step-timeout` or `transient: false`) -> `bounded-infra-retry` up to `retryLimit <= 2` for verified transient runner faults, or `diagnose-stage-timeout` without retry for deterministic stage hangs
- `dependency-lock` (`npm-lock-mismatch`, `nuget-restore-mismatch`, `toolchain-version-drift`) -> `reconcile-locked-dependencies`
- `permission` (`http-401-unauthorized`, `http-403-forbidden`, `missing-workflow-permission`, `fork-restriction`) -> `escalate-permission-review`

Blind retries are explicitly rejected (`allowRetry: false`, `blindRetryRejected: true`) on all deterministic failures (`test`, `coverage`, `security`, `dependency-lock`, `permission`, and non-transient `infra` / `job-step-timeout` hangs), and bounded code/test repair attempts escalate once `maxRepairAttempts <= 2` is exhausted.

## Experiment comparison

`compareTrainExperiment` reports a matched synthetic comparison only when each pair has the same workload, gate set, and accepted work, with no candidate rework or cost regression. It reports the synthetic durations and ratio. These figures do not establish production latency or speedup.

## Acceptance status

These pure evaluator components do not execute GitHub Actions workflows directly or claim measured hosted CI latency improvements on their own. Workflow wiring in `.github/workflows/validate.yml` and `.github/workflows/windows-aspire.yml`, security review, and matched cold/warm hosted p50/p95 benchmarks remain separate exact-head evidence requirements while retaining all required platform, security, coverage, review, and merge-group gates.

