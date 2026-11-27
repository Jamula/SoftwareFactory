# GitHub-hosted Copilot execution pilot (M01.07.01 `#105` / M01.08 `#10`; historical M02.08)

Owner direction, November 26, 2026: move execution off the laptop and into GitHub, use existing personal Copilot credits for Jamula where permitted, discover actual constraints, and preserve the zero-incremental-cost and independent-review requirements. This is the first credential-isolated provider smoke test, not automatic code-writing or dispatch acceptance.

## Merged `#106` exact-byte response verification

Merged [#104](https://github.com/Jamula/SoftwareFactory/pull/104) and [#106](https://github.com/Jamula/SoftwareFactory/pull/106) are on protected `main` in `.github/workflows/copilot-hosted-pilot.yml`:

- The workflow installs the SHA-256-verified official Linux Copilot CLI `v1.0.116` release in an isolated `0700` temp directory without repository checkout, package scripts, third-party actions, shell/write delegation, subagents, or `GITHUB_TOKEN` fallback.
- The single synthetic prompt requests `FACTORY_COPILOT_PILOT_5` with `--max-ai-credits=1` (soft CLI guard only, never a substitute for provider hard-stop enforcement).
- The exact-byte shell guard (`cmp -s`) accepts **only** the complete stdout byte sequence `FACTORY_COPILOT_PILOT_5` or `FACTORY_COPILOT_PILOT_5\n` (one optional trailing LF). Any prefix, trailing text without a terminal newline, extra newline, CRLF, whitespace, NUL byte, empty output, or missing file fails closed before `COPILOT_HOSTED_SYNTHETIC_RESPONSE_VERIFIED` is written to `$GITHUB_STEP_SUMMARY`.
- `tests/engineering-factory/copilot-hosted-pilot.test.mjs` executes the extracted workflow guard offline against valid and invalid byte sequences without credentials or provider calls.

## Owner `#105` (`M01.07.01`) one-time configuration and smoke-run checklist

Only the default `copilot` GitHub environment exists until the owner completes these authenticated settings steps:

- [x] Verify merged [#104](https://github.com/Jamula/SoftwareFactory/pull/104) and [#106](https://github.com/Jamula/SoftwareFactory/pull/106) exact-byte `FACTORY_COPILOT_PILOT_5` verification, independent review, exact-head CI, and healthy protected `main`.
- [ ] In an authorized authenticated GitHub session, verify personal Copilot access, remaining included AI credits, personal paid-usage hard stop, and applicable organization AI policy. Screenshots and statements establish intended BYOC routing, not provider-side enforcement or a current authenticated quota response. Do not enable paid overages or increase any budget.
- [ ] In GitHub personal settings, create a short-lived **user-owned fine-grained PAT** (`github_pat_*`) with **only** the account permission **Copilot Requests**. Grant no repository write, workflow, or admin permissions. Never paste credential values in chat, issues, logs, or source.
- [ ] In SoftwareFactory `Settings > Environments`, create `factory-copilot-pilot`, restrict deployment branches to the exact protected `main` branch, and store the PAT directly as environment secret `FACTORY_COPILOT_REQUESTS_TOKEN` (no other secrets in this environment and no repository-wide secret).
- [ ] Only after independent review and verified provider-side spending controls, set repository variables `FACTORY_COPILOT_INCLUDED_ONLY_CONFIRMED=true` and `FACTORY_COPILOT_PILOT_ENABLED=true` (exact lowercase), verifying by name and non-secret metadata only.
- [ ] From `Actions > Factory Copilot hosted pilot`, run one manual `workflow_dispatch` on `main` (no schedule, PR trigger, rerun, or automatic retry). Stop immediately on unknown quota, auth failure, unexpected output, or billing anomaly.
- [ ] Compare personal and organization billing before/after (allowing for reporting delay); record exact workflow run ID, commit revision, `COPILOT_HOSTED_SYNTHETIC_RESPONSE_VERIFIED` summary receipt, actual credits consumed, attribution, runner duration, and `$0` additional billable spend.
- [ ] Immediately disable `FACTORY_COPILOT_PILOT_ENABLED` and `FACTORY_COPILOT_INCLUDED_ONLY_CONFIRMED` after the single synthetic run (and revoke the PAT if anything is unexpected). Synthetic response verification does not prove autonomous coding readiness.

## `#10` (`M01.08`) autonomous SoftwareFactory readiness and exit checklist

Offline preflight and exit-evidence evaluators in `tools/engineering-factory/pilot-readiness.mjs` (`pilotReadiness`, `evaluateSelfPilotCycles`, and `verifyM01AutonomousExit`) validate synthetic and normalized metadata with `shadow: true`, `liveActivation: false`, and `accepted: false`; they never grant live dispatch authority or replace actual GitHub-hosted pilot receipts.

### M01 structural entry prerequisites (`M01_STRUCTURAL_PREREQUISITES`)

- [ ] `noPythonVerified` — Node.js dashboard/metrics verification and no-Python workflow guard ([#118](https://github.com/Jamula/SoftwareFactory/issues/118))
- [ ] `boundedLeaseTtlVerified` — bounded lease TTL enforcement ([#6](https://github.com/Jamula/SoftwareFactory/issues/6), [#116](https://github.com/Jamula/SoftwareFactory/issues/116))
- [ ] `crossRunStateVerified` — durable, least-privilege cross-run GitHub-hosted ownership and reconciliation ([#5](https://github.com/Jamula/SoftwareFactory/issues/5), [#6](https://github.com/Jamula/SoftwareFactory/issues/6))
- [ ] `protectedEnvironmentVerified` — protected `factory-copilot-pilot` environment restricted to `main` and wired protected expected-head integration ([#8](https://github.com/Jamula/SoftwareFactory/issues/8), [#105](https://github.com/Jamula/SoftwareFactory/issues/105))
- [ ] `hardStopBillingVerified` — verified included-only Copilot entitlement, enforceable paid-usage hard stop, and `$0` incremental spend receipt ([#105](https://github.com/Jamula/SoftwareFactory/issues/105))
- [ ] `laptopOfflineRecoveryVerified` — GitHub-hosted restart and 10-minute missed-event recovery proven with personal laptop and chat offline ([#5](https://github.com/Jamula/SoftwareFactory/issues/5), [#6](https://github.com/Jamula/SoftwareFactory/issues/6))
- [ ] `stopSwitchVerified` — per-repository emergency stop switch, cancellation, and rollback verified ([#6](https://github.com/Jamula/SoftwareFactory/issues/6), [#8](https://github.com/Jamula/SoftwareFactory/issues/8))

### M01 exit evidence requirements

- [ ] At least **3 distinct independently accepted unattended cycles** on `Jamula/SoftwareFactory` (`repositoryId: 1471342715`; consumer pilots `#36`, `#11`, and `#12` pass their own `options.repositoryId` to `evaluateSelfPilotCycles` under separate authorization)
- [ ] Both `parallelCandidate` and `reviewFix` scenarios demonstrated across accepted cycles through healthy protected `main`
- [ ] Exact-head independent review (including summary-only findings disposition), complete trusted required checks and security gates, and `>=98%` line / `>=95%` branch coverage per executable component and overall
- [ ] `0` human interventions, `0` duplicate dispatches, `0` unauthorized writes, `0` gate bypasses, and `$0` incremental spend
- [ ] Explicit `actualWorkerMax` and `workerShortfallFrom12` (`Math.max(0, 12 - actualWorkerMax)`) recorded against the `1 -> 2 -> 4 -> 8 -> 10 -> 12` hosted worker ladder

## Subsequent gated rollout

| Stage | Requirement before enabling |
| --- | --- |
| P0 | One synthetic read-only invocation (`#105`), verified personal entitlement, budget hard stop, auth, exact-byte response, and billing evidence |
| P1 | One isolated code worker on approved issue; review input provenance and sandbox; no write credentials in agent environment; validate bounded candidate diff in separate trusted publisher |
| P2 | Atomic repository/issue leases and durable reservation ledger; trusted events, retry/backoff, stale-head checks, stop and independent review; auto-publish only scoped changes |
| P3 | Scale 1/2/4/8/10/12 only from actual concurrent execution and verified remaining quota; native protected merge queue, exact-head CI and verified main |
| P4 | Event-triggered work replenishment and ten-minute best-effort recovery; no laptop or chat dependency; repeatable unattended three-issue pilot (`#10`) |

Do not treat Actions matrices as actual agents, or a successful synthetic response as proof of live coding, billing or quota. A public repository cannot rely on a branch-local self-attestation for trust. Protect the environment, validate every workflow update independently, keep agent credentials isolated from generated code and separate publication from inference. No consumer activation or paid fallback. Existing shadow reconciliation remains unchanged.

Official documentation: https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions and https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions and https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference .
