# GitHub-hosted Copilot execution pilot (M01.07.01 `#105` / M01.08 `#10`; historical M02.08)

Owner architectural decision, November 26, 2026: SoftwareFactory standardizes on **native GitHub Cloud Agents (`copilot-swe-agent[bot]` / Repository Cloud Automations)** orchestrated by GitHub rather than downloading a `copilot-cli` tarball inside GitHub Actions with a personal token secret. Execution runs off the laptop with zero personal PATs stored in Actions secrets, no custom `factory-copilot-pilot` environment, a mandatory `$0` paid-overage billing hard stop, and preserved exact-head CI and independent review gates.

## Native GitHub Cloud Agent architecture (retired DIY Actions CLI pilot)

Per slimmed [#105](https://github.com/Jamula/SoftwareFactory/issues/105), hosted execution uses GitHub's native cloud agent infrastructure:

- **Native execution plane:** Work executes via `copilot-swe-agent[bot]` and Repository Cloud Automations on `Jamula/SoftwareFactory` using GitHub-managed ephemeral identities—never by downloading or running a `copilot-cli` archive inside a GitHub Actions workflow.
- **Zero personal PATs in Actions secrets:** No `FACTORY_COPILOT_REQUESTS_TOKEN` or user-owned fine-grained PAT is created or stored in repository or environment secrets, and no custom `factory-copilot-pilot` Actions environment or `FACTORY_COPILOT_PILOT_ENABLED` / `FACTORY_COPILOT_INCLUDED_ONLY_CONFIRMED` repository variables are used.
- **Mandatory `$0` paid-overage hard stop:** Budget safety is enforced at the provider billing boundary by setting paid overages for both **Copilot Premium Requests** and **GitHub Actions** to `$0` / disabled so cloud agent sessions and workflows stop automatically when included monthly quota is reached.
- **Retired DIY artifacts:** The obsolete `.github/workflows/copilot-hosted-pilot.yml` workflow and its workflow-specific shell-guard test `tests/engineering-factory/copilot-hosted-pilot.test.mjs` (historical PRs [#104](https://github.com/Jamula/SoftwareFactory/pull/104) and [#106](https://github.com/Jamula/SoftwareFactory/pull/106)) are removed. Candidate changes remain gated by trusted repository CI (`.github/workflows/validate.yml`), exact-head source coverage (`>=98%` lines / `>=95%` branches), and independent review before protected `main` integration.

## Owner `#105` (`M01.07.01`) slimmed billing hard-stop and native cloud smoke checklist

Entry criteria: repository admin and GitHub Billing visibility on `Jamula` / personal Copilot account, with zero personal PATs in repository or environment secrets and no custom `factory-copilot-pilot` environment.

- [ ] **Billing hard-stop (`$0` overage):** In an authenticated GitHub Billing settings session, confirm that **Copilot Premium Requests** and **GitHub Actions** paid overages are set to `$0` / disabled so native cloud agent runs and Actions workflows stop automatically when included monthly quota is reached. Do not enable paid overages or raise any budget limit.
- [ ] **Native cloud smoke receipt:** Confirm `copilot-swe-agent[bot]` / Repository Cloud Automations are enabled on `Jamula/SoftwareFactory`, execute one minimal native cloud smoke task or Repository Cloud Automation without laptop or open-chat dependency, and record the cloud session/task ID (plus any linked run/PR reference), included-quota attribution, and `$0` incremental billed spend. Stop immediately on unknown quota, policy denial, or unexpected billing attribution. A smoke receipt verifies provider entitlement and `$0` overage enforcement; it does not by itself satisfy `#10` autonomous coding acceptance.

## `#10` (`M01.08`) autonomous SoftwareFactory readiness and exit checklist

Offline preflight and exit-evidence evaluators in `tools/engineering-factory/pilot-readiness.mjs` (`pilotReadiness`, `evaluateSelfPilotCycles`, and `verifyM01AutonomousExit`) validate synthetic and normalized metadata with `shadow: true`, `liveActivation: false`, and `accepted: false`; they never grant live dispatch authority or replace actual native GitHub Cloud Agent billing and cycle receipts.

### M01 structural entry prerequisites (`M01_STRUCTURAL_PREREQUISITES`)

- [ ] `noPythonVerified` — Node.js dashboard/metrics verification and no-Python workflow guard ([#118](https://github.com/Jamula/SoftwareFactory/issues/118))
- [ ] `boundedLeaseTtlVerified` — bounded lease TTL enforcement ([#6](https://github.com/Jamula/SoftwareFactory/issues/6), [#116](https://github.com/Jamula/SoftwareFactory/issues/116))
- [ ] `crossRunStateVerified` — durable, least-privilege cross-run GitHub-hosted ownership and reconciliation ([#5](https://github.com/Jamula/SoftwareFactory/issues/5), [#6](https://github.com/Jamula/SoftwareFactory/issues/6))
- [ ] `protectedEnvironmentVerified` — protected `main` branch/merge-group ruleset governance and wired expected-head protected-integration evidence adapter ([#8](https://github.com/Jamula/SoftwareFactory/issues/8); no custom `factory-copilot-pilot` PAT environment)
- [ ] `hardStopBillingVerified` — verified `$0` paid-overage hard stop on **Copilot Premium Requests** and **GitHub Actions**, plus native GitHub Cloud Agent (`copilot-swe-agent[bot]` / Repository Cloud Automations) smoke receipt with `$0` incremental spend ([#105](https://github.com/Jamula/SoftwareFactory/issues/105))
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
| P0 | Slimmed `#105` owner verification: `$0` paid-overage hard stop on Copilot Premium Requests and GitHub Actions, zero personal PATs in Actions secrets, no `factory-copilot-pilot` environment, and one minimal native GitHub Cloud Agent (`copilot-swe-agent[bot]` / Repository Cloud Automations) smoke receipt confirming included-quota attribution with `$0` incremental spend |
| P1 | One isolated native cloud worker (`copilot-swe-agent[bot]` / Cloud Automations) on an approved issue; review input provenance and sandbox; no personal PATs or direct `main` write credentials in agent environment; validate bounded candidate diff via trusted repository CI and independent review |
| P2 | Atomic repository/issue leases and durable cross-run reservation ledger (`#6`, `#7`); trusted events, retry/backoff, stale-head checks, stop switch, and independent review (`#8`); serialized protected integration only |
| P3 | Scale `1 -> 2 -> 4 -> 8 -> 10 -> 12` actual concurrent native cloud workers only from verified concurrent execution and remaining included quota (`#7`); native protected merge queue / expected-head squash, exact-head CI, and verified `main` |
| P4 | Event-triggered work replenishment and ten-minute best-effort recovery (`#5`, `#6`); no laptop or chat dependency; repeatable unattended three-issue pilot (`#10`) evaluated alongside `pilot-readiness.mjs` |

Do not treat logical lanes or Actions matrices as concurrent cloud agents, or a single smoke receipt as proof of full autonomous coding readiness. A public repository cannot rely on branch-local self-attestation for trust. Enforce protected `main` integration, validate every workflow or policy change independently, never store personal PATs in repository or environment secrets, and separate merge authority from agent execution. No consumer activation or paid fallback. Existing shadow reconciliation remains unchanged.

Official documentation: https://docs.github.com/en/copilot/using-github-copilot/coding-agent and https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-copilot/managing-your-github-copilot-spending-limit .
