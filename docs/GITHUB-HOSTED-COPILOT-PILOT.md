# GitHub-hosted Copilot execution pilot (M01.07.01 `#105` / M01.08 `#10`; historical M02.08)

Owner architectural decision, November 26, 2026: SoftwareFactory standardizes on **native GitHub Cloud Agents (`copilot-swe-agent[bot]` / Repository Cloud Automations)** orchestrated by GitHub rather than downloading a `copilot-cli` tarball inside GitHub Actions with a personal token secret. Execution runs off the laptop with zero personal PATs stored in Actions secrets, no custom `factory-copilot-pilot` environment, a mandatory `$0` paid-overage billing hard stop, and preserved exact-head CI and independent review gates.

## Native GitHub Cloud Agent architecture (retired DIY Actions CLI pilot)

Per slimmed [#105](https://github.com/Jamula/SoftwareFactory/issues/105), hosted execution uses GitHub's native cloud agent infrastructure:

- **Native execution plane:** Work executes via `copilot-swe-agent[bot]` and Repository Cloud Automations on `Jamula/SoftwareFactory` using GitHub-managed ephemeral identities—never by downloading or running a `copilot-cli` archive inside a GitHub Actions workflow.
- **Repository visibility rule:** **Copilot Cloud Automations / Automation Groups** currently require `private` or `internal` repositories (`AUTOMATIONS_REQUIRE_PRIVATE_REPO` on `public`), whereas **Copilot Cloud Agent (`copilot-swe-agent[bot]`)**, `github/gh-aw`, and `@microsoft/copilot-sdk` (`v2.0.3`) operate across `public`, `private`, and `internal` repositories. On public `Jamula/SoftwareFactory`, native smoke tasks execute via `copilot-swe-agent[bot]`.
- **Zero personal PATs in Actions secrets:** No `FACTORY_COPILOT_REQUESTS_TOKEN` or user-owned fine-grained PAT is created or stored in repository or environment secrets, and no custom `factory-copilot-pilot` Actions environment or `FACTORY_COPILOT_PILOT_ENABLED` / `FACTORY_COPILOT_INCLUDED_ONLY_CONFIRMED` repository variables are used.
- **Mandatory `$0` paid-overage hard stop across all three meters:** Budget safety is enforced at the provider billing boundary by setting paid overages (`overageLimitUsdCents === 0`, `overageAllowed === false`) to `$0` / disabled across **GitHub AI Credits** (`1 AI credit = $0.01`), **Copilot Premium Requests**, and **Cloud Sandboxes / GitHub Actions** so native cloud agent sessions, sandboxes, and workflows stop automatically when included monthly quota is reached. Supplemental `github/gh-aw` (`max-ai-credits` / `max-daily-ai-credits`) and Copilot SDK caps are soft caps only (because `gh-aw` can fall back to per-run estimates when historical usage cannot be read); SoftwareFactory's admission and receipt verifiers reject missing or estimated accounting fail-closed (`accountingSource === "verified"`, `isEstimated === false`).
- **Retired DIY artifacts:** The obsolete `.github/workflows/copilot-hosted-pilot.yml` workflow and its workflow-specific shell-guard test `tests/engineering-factory/copilot-hosted-pilot.test.mjs` (historical PRs [#104](https://github.com/Jamula/SoftwareFactory/pull/104) and [#106](https://github.com/Jamula/SoftwareFactory/pull/106)) were removed in [#134](https://github.com/Jamula/SoftwareFactory/pull/134). Candidate changes remain gated by trusted repository CI (`.github/workflows/validate.yml`), exact-head source coverage (`>=98%` lines / `>=95%` branches), and independent review before protected `main` integration.

## Owner `#105` (`M01.07.01`) slimmed billing hard-stop and native cloud smoke checklist

Entry criteria: repository admin and GitHub Billing visibility on `Jamula` / personal Copilot account, with zero personal PATs in repository or environment secrets and no custom `factory-copilot-pilot` environment.

- [ ] **Billing hard-stop (`$0` overage across all 3 meters):** In an authenticated GitHub Billing settings session, confirm and record that paid-overage budgets (`overageLimitUsdCents: 0`, `overageAllowed: false`) are set to `$0` / disabled across **GitHub AI Credits** (`1 AI credit = $0.01`), **Copilot Premium Requests**, and **Cloud Sandboxes / GitHub Actions** so native cloud agent runs, sandboxes, and Actions workflows stop automatically when included monthly quota is reached. Do not enable paid overages or raise any budget limit.
- [ ] **Native cloud smoke receipt:** Confirm `copilot-swe-agent[bot]` (or Repository Cloud Automations on `private` / `internal` repositories) is enabled on `Jamula/SoftwareFactory`, execute one minimal native cloud smoke task via GitHub Mission Control / Cloud Agent without laptop or open-chat dependency, and record the Mission Control `taskId` (UUID), `sessionId`, `actor: "copilot-swe-agent[bot]"`, included-quota attribution (`includedQuotaAttributed: true`), verified non-estimated accounting (`accountingSource: "verified"`), and `$0` observed incremental billed spend (`incrementalBilledUsdCents: 0`). Stop immediately on unknown/estimated quota, policy denial, or unexpected billing attribution. A smoke receipt within remaining included quota verifies provider entitlement, attribution, and observed spend only—not paid-overage hard-stop enforcement, which requires separate authenticated verification of all three `$0` billing hard stops above—and does not by itself satisfy `#10` autonomous coding acceptance.
- [x] **Retire obsolete DIY Actions workflow:** `.github/workflows/copilot-hosted-pilot.yml` and `tests/engineering-factory/copilot-hosted-pilot.test.mjs` removed in [#134](https://github.com/Jamula/SoftwareFactory/pull/134), and deterministic receipt verifier added in `tools/engineering-factory/billing-hardstop-smoke.mjs`.

## Step-by-step owner verification procedure (`#105`)

Offline evaluators never fabricate live owner billing settings or check off `#105` autonomously. Execute the ~5-minute owner check in an authenticated GitHub browser + CLI session as follows:

1. **Verify repository secret, environment, and workflow hygiene (`Jamula/SoftwareFactory`):**
   - Confirm `.github/workflows/copilot-hosted-pilot.yml` remains absent on `main`.
   - Open **Repository Settings -> Secrets and variables -> Actions** and **Environments** (or run `gh secret list --repo Jamula/SoftwareFactory` and `gh api repos/Jamula/SoftwareFactory/environments`) and confirm zero personal PAT secrets (`FACTORY_COPILOT_REQUESTS_TOKEN` absent) and no custom `factory-copilot-pilot` environment (`retiredDiyWorkflowAbsent: true`, `zeroPersonalPatSecretsVerified: true`, `customPilotEnvironmentAbsent: true`).
2. **Verify `$0` paid-overage hard-stop budgets across all three GitHub Billing meters:**
   - Open **GitHub Settings -> Billing & Licensing -> Budgets and alerts** (and **Usage / Spending limits**) for the `Jamula` account.
   - Confirm and record that paid overages are disabled (`$0.00` overage budget / stop usage when limit is reached; `overageLimitUsdCents: 0`, `overageAllowed: false`) for all three meters:
     1. **GitHub AI Credits** (`aiCredits`, where `1 AI credit = $0.01` / `1` USD cent)
     2. **Copilot Premium Requests** (`copilotPremiumRequests`)
     3. **Cloud Sandboxes / GitHub Actions** (`cloudSandboxesAndActions`)
   - Do **not** raise any budget above `$0` or rely solely on `gh-aw` / SDK soft caps.
3. **Execute one minimal native Cloud Agent smoke check without laptop/open-chat dependency:**
   - On `Jamula/SoftwareFactory` (`repositoryId: 1471342715`, `repositoryVisibility: "public"`), trigger one minimal read-only/bounded native **Copilot Cloud Agent** task (`harness: "copilot-cloud-agent"`, `actor: "copilot-swe-agent[bot]"`) from GitHub Issues / Mission Control on github.com, then close any local terminal/chat so execution completes strictly on GitHub's cloud infrastructure (`runner: "github-hosted"` or `"cloud-sandbox"`, `laptopOrChatDependency: false`). *(Note: `harness: "copilot-cloud-automation"` is valid only when `repositoryVisibility` is `"private"` or `"internal"`.)*
   - From **Mission Control** and **GitHub Billing -> Usage**, record the canonical `taskId` UUID, `sessionId`, `actor` (`"copilot-swe-agent[bot]"`), optional `linkedPullRequest` / `linkedRunId`, `includedQuotaAttributed: true`, `incrementalBilledUsdCents: 0`, and `accountingSource: "verified"` (`isEstimated: false`). If billing usage is still pending, missing, or estimated, wait or stop fail-closed—never record estimated accounting as verified.
4. **Validate the recorded receipt deterministically and post to [#105](https://github.com/Jamula/SoftwareFactory/issues/105):**
   - Save the owner-observed JSON receipt to a temporary local file (for example `/tmp/issue-105-receipt.json`) and validate it offline against the current clock (`{nowMs: Date.now()}` at the CLI boundary so expired saved receipts fail closed rather than reusing a historical `receipt.nowMs`):
     ```bash
     node --input-type=module -e '
       import {readFileSync} from "node:fs";
       import {verifyBillingHardStopAndSmokeReceipt} from "./tools/engineering-factory/billing-hardstop-smoke.mjs";
       const receipt = JSON.parse(readFileSync("/tmp/issue-105-receipt.json", "utf8"));
       const result = verifyBillingHardStopAndSmokeReceipt(receipt, {nowMs: Date.now()});
       console.log(JSON.stringify(result, null, 2));
       if (!result.verified) process.exit(1);
     '
     ```
   - Paste the verified non-secret receipt metadata into `#105` and check off the two remaining exit checkboxes once verified.

## `#105` JSON receipt schema (`tools/engineering-factory/billing-hardstop-smoke.mjs`)

`verifyBillingHardStopAndSmokeReceipt(input, options?)` validates plain JSON objects (`Object.prototype`, own enumerable data descriptors only, `types.isProxy` rejected before inspection) and always returns a frozen shadow result (`shadow: true`, `liveActivation: false`, `autonomousExitAccepted: false`) whose `reason` maps cleanly through `tools/engineering-factory/telemetry.mjs`. Passing `options.nowMs` (for example `{nowMs: Date.now()}` at an interactive CLI boundary) enforces freshness against the live verification time while keeping the evaluator itself deterministic.

Synthetic schema example (**non-live template** — replace timestamps and IDs with actual owner-observed values during `#105` verification):

```json
{
  "schemaVersion": 1,
  "stop": false,
  "repository": "Jamula/SoftwareFactory",
  "repositoryId": 1471342715,
  "repositoryVisibility": "public",
  "nowMs": 1795773600000,
  "maxReceiptAgeMs": 86400000,
  "retiredDiyWorkflowAbsent": true,
  "zeroPersonalPatSecretsVerified": true,
  "customPilotEnvironmentAbsent": true,
  "billingHardStop": {
    "authenticatedBillingCheck": true,
    "observedAtMs": 1795773480000,
    "aiCreditUnitUsdCents": 1,
    "ghAwCapsSoftOnlyAcknowledged": true,
    "meters": {
      "aiCredits": {
        "verified": true,
        "overageLimitUsdCents": 0,
        "overageAllowed": false
      },
      "copilotPremiumRequests": {
        "verified": true,
        "overageLimitUsdCents": 0,
        "overageAllowed": false
      },
      "cloudSandboxesAndActions": {
        "verified": true,
        "overageLimitUsdCents": 0,
        "overageAllowed": false
      }
    }
  },
  "smokeReceipt": {
    "harness": "copilot-cloud-agent",
    "runner": "github-hosted",
    "laptopOrChatDependency": false,
    "taskId": "01936d8e-7f2a-7b00-8a11-3c4d5e6f7081",
    "sessionId": "mc-sess-synthetic-example-01",
    "actor": "copilot-swe-agent[bot]",
    "observedAtMs": 1795773540000,
    "includedQuotaAttributed": true,
    "incrementalBilledUsdCents": 0,
    "accountingSource": "verified",
    "isEstimated": false,
    "aiCreditsUsed": 4,
    "premiumRequestsUsed": 1,
    "linkedPullRequest": null,
    "linkedRunId": null
  }
}
```

| Field | Contract | Fail-closed denial (`reason` / `verificationCode`) |
| --- | --- | --- |
| `stop` | Required `false` | `STOPPED` / `STOP_SWITCH_ACTIVE` |
| `repository`, `repositoryId` | Required exact match against expected target (`Jamula/SoftwareFactory` + `1471342715` by default; consumer `options` must supply both slug and ID) | `INVALID_IDENTITY` / `REPOSITORY_IDENTITY_INVALID`, `PROVENANCE_MISMATCH` / `REPOSITORY_SCOPE_MISMATCH` |
| `repositoryVisibility` | Required `'public' \| 'private' \| 'internal'` | `EVIDENCE_UNKNOWN` / `REPOSITORY_OR_CLOCK_INVALID` |
| `nowMs?`, `options.nowMs?`, `maxReceiptAgeMs?` | Non-negative safe integer clock required via `options.nowMs` (authoritative verification time, recommended at CLI boundary) or `input.nowMs` (`input.nowMs <= options.nowMs` when both present); optional `1 <= maxReceiptAgeMs <= 2,592,000,000` (default `86,400,000` ms) | `EVIDENCE_UNKNOWN` / `REPOSITORY_OR_CLOCK_INVALID`, `STALE_EVIDENCE` / `RECEIPT_TIMESTAMP_IN_FUTURE`, `INVALID_POLICY` / `VERIFIER_OPTIONS_INVALID`, `MAX_RECEIPT_AGE_INVALID` |
| `retiredDiyWorkflowAbsent`, `zeroPersonalPatSecretsVerified`, `customPilotEnvironmentAbsent?` | Required `true` (`customPilotEnvironmentAbsent` optional `true`) | `PROVIDER_FORBIDDEN` / `RETIRED_DIY_WORKFLOW_PRESENT`, `PERSONAL_PAT_SECRETS_FORBIDDEN`, `CUSTOM_PILOT_ENVIRONMENT_FORBIDDEN` |
| `billingHardStop.authenticatedBillingCheck`, `observedAtMs`, `aiCreditUnitUsdCents?`, `ghAwCapsSoftOnlyAcknowledged?` | `authenticatedBillingCheck === true`, `0 <= nowMs - observedAtMs <= maxReceiptAgeMs`, optional `aiCreditUnitUsdCents === 1` (`$0.01`) and `ghAwCapsSoftOnlyAcknowledged === true` | `BUDGET_UNKNOWN` / `BILLING_CHECK_UNAUTHENTICATED`, `STALE_EVIDENCE` / `BILLING_TIMESTAMP_IN_FUTURE`, `STALE_QUOTA` / `STALE_BILLING_HARD_STOP_RECEIPT`, `INVALID_POLICY` |
| `billingHardStop.meters.{aiCredits,copilotPremiumRequests,cloudSandboxesAndActions}` | All 3 meters required with `verified === true`, `overageLimitUsdCents === 0`, and `overageAllowed === false` | `BUDGET_UNKNOWN` / `HARD_STOP_METERS_INCOMPLETE`, `HARD_STOP_METER_INVALID`, `HARD_STOP_METER_UNVERIFIED`, `PAID_OVERAGE_ALLOWED`, `OVERAGE_LIMIT_NONZERO` |
| `smokeReceipt.harness`, `runner?`, `laptopOrChatDependency?` | `harness` in `['copilot-cloud-agent', 'copilot-cloud-automation']` (`'copilot-cloud-automation'` rejected on `'public'`), optional `runner` in `['github-hosted', 'cloud-sandbox']`, optional `laptopOrChatDependency === false` | `PROVIDER_FORBIDDEN` / `UNSUPPORTED_SMOKE_HARNESS`, `CAPACITY_UNVERIFIED` / `AUTOMATIONS_REQUIRE_PRIVATE_REPO`, `PROVIDER_FORBIDDEN` / `UNSUPPORTED_SMOKE_RUNNER`, `LAPTOP_OR_CHAT_DEPENDENCY_FORBIDDEN` |
| `smokeReceipt.taskId`, `sessionId`, `actor`, `observedAtMs`, `linkedPullRequest?`, `linkedRunId?` | RFC UUID `taskId` (v1–v8), bounded `sessionId`, `actor === "copilot-swe-agent[bot]"`, fresh `observedAtMs`, optional positive-int or `null` PR/run refs | `EVIDENCE_UNKNOWN` / `SMOKE_TASK_ID_INVALID`, `SMOKE_SESSION_ID_INVALID`, `SMOKE_LINKED_REFERENCE_INVALID`, `PROVENANCE_MISMATCH` / `SMOKE_ACTOR_MISMATCH` |
| `smokeReceipt.accountingSource`, `isEstimated?`, `includedQuotaAttributed`, `incrementalBilledUsdCents`, `aiCreditsUsed?`, `premiumRequestsUsed?` | `accountingSource === "verified"`, optional `isEstimated === false`, `includedQuotaAttributed === true`, `incrementalBilledUsdCents === 0`, optional bounded integer credit/request counts | `BUDGET_UNKNOWN` / `ACCOUNTING_ESTIMATED_OR_MISSING`, `INCLUDED_QUOTA_NOT_ATTRIBUTED`, `INCREMENTAL_SPEND_NONZERO` |

## `#10` (`M01.08`) autonomous SoftwareFactory readiness and exit checklist

Offline preflight and exit-evidence evaluators in `tools/engineering-factory/pilot-readiness.mjs` (`pilotReadiness`, `evaluateSelfPilotCycles`, and `verifyM01AutonomousExit`) validate synthetic and normalized metadata with `shadow: true`, `liveActivation: false`, and `accepted: false`; they never grant live dispatch authority or replace actual native GitHub Cloud Agent billing and cycle receipts.

### M01 structural entry prerequisites (`M01_STRUCTURAL_PREREQUISITES`)

- [ ] `noPythonVerified` — Node.js dashboard/metrics verification and no-Python workflow guard ([#118](https://github.com/Jamula/SoftwareFactory/issues/118))
- [ ] `boundedLeaseTtlVerified` — bounded lease TTL enforcement ([#6](https://github.com/Jamula/SoftwareFactory/issues/6), [#116](https://github.com/Jamula/SoftwareFactory/issues/116))
- [ ] `crossRunStateVerified` — durable, least-privilege cross-run GitHub-hosted ownership and reconciliation ([#5](https://github.com/Jamula/SoftwareFactory/issues/5), [#6](https://github.com/Jamula/SoftwareFactory/issues/6))
- [ ] `protectedEnvironmentVerified` — protected `main` branch/merge-group ruleset governance and wired expected-head protected-integration evidence adapter ([#8](https://github.com/Jamula/SoftwareFactory/issues/8); no custom `factory-copilot-pilot` PAT environment)
- [ ] `hardStopBillingVerified` — separately authenticated GitHub Billing verification of `$0` / disabled paid overages across **GitHub AI Credits** (`1 AI credit = $0.01`), **Copilot Premium Requests**, and **Cloud Sandboxes / GitHub Actions**, plus a native GitHub Cloud Agent (`copilot-swe-agent[bot]` / Repository Cloud Automations on `private`/`internal` repos) smoke receipt confirming entitlement, verified non-estimated accounting, included-quota attribution, and `$0` observed incremental spend ([#105](https://github.com/Jamula/SoftwareFactory/issues/105), validated offline via `tools/engineering-factory/billing-hardstop-smoke.mjs`)
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
| P0 | Slimmed `#105` owner verification (`tools/engineering-factory/billing-hardstop-smoke.mjs`): `$0` paid-overage hard stop across GitHub AI Credits (`1 AI credit = $0.01`), Copilot Premium Requests, and Cloud Sandboxes / GitHub Actions, zero personal PATs in Actions secrets, no `factory-copilot-pilot` environment, and one minimal native GitHub Cloud Agent (`copilot-swe-agent[bot]`, or Repository Cloud Automations on `private`/`internal` repos) smoke receipt confirming verified accounting, included-quota attribution, and `$0` incremental spend |
| P1 | One isolated native cloud worker (`copilot-swe-agent[bot]` / Cloud Automations) on an approved issue; review input provenance and sandbox; no personal PATs or direct `main` write credentials in agent environment; validate bounded candidate diff via trusted repository CI and independent review |
| P2 | Atomic repository/issue leases and durable cross-run reservation ledger (`#6`, `#7`); trusted events, retry/backoff, stale-head checks, stop switch, and independent review (`#8`); serialized protected integration only |
| P3 | Scale `1 -> 2 -> 4 -> 8 -> 10 -> 12` actual concurrent native cloud workers only from verified concurrent execution and remaining included quota (`#7`); native protected merge queue / expected-head squash, exact-head CI, and verified `main` |
| P4 | Event-triggered work replenishment and ten-minute best-effort recovery (`#5`, `#6`); no laptop or chat dependency; repeatable unattended three-issue pilot (`#10`) evaluated alongside `pilot-readiness.mjs` |

Do not treat logical lanes or Actions matrices as concurrent cloud agents, or a single smoke receipt as proof of paid-overage hard-stop enforcement or full autonomous coding readiness. A public repository cannot rely on branch-local self-attestation for trust. Enforce protected `main` integration, validate every workflow or policy change independently, never store personal PATs in repository or environment secrets, and separate merge authority from agent execution. No consumer activation or paid fallback. Existing shadow reconciliation remains unchanged.

Official documentation: https://docs.github.com/en/copilot/using-github-copilot/coding-agent and https://docs.github.com/en/billing/managing-billing-for-your-products/managing-billing-for-github-copilot/managing-your-github-copilot-spending-limit .
