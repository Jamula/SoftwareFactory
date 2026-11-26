# GitHub-hosted Copilot execution pilot (M02.08)

Owner direction, November 26, 2026: move execution off the laptop and into GitHub, use existing personal Copilot credits for Jamula where permitted, discover actual constraints, and preserve the zero-incremental-cost and independent-review requirements. This is the first credential-isolated provider smoke test, not automatic code-writing or dispatch acceptance.

## One-time configuration after protected merge

1. Verify personal Copilot access and remaining included AI credits; verify the personal paid-usage hard stop and applicable organization AI policy. The user's screenshots and statement establish available credits and intended BYOC routing, not the provider-side enforcement or a current authenticated quota response. Do not enable paid overages or increase any budget.
2. In GitHub personal settings create a **user-owned fine-grained PAT**, with only the account permission **Copilot Requests**. Do not grant repository writes, admin or workflow permissions. Use the shortest practical expiry. Never paste it in chat, an issue or source.
3. In SoftwareFactory Settings > Environments create `factory-copilot-pilot`. Restrict deployment branches to the exact protected `main` branch. Store the PAT as that environment's secret `FACTORY_COPILOT_REQUESTS_TOKEN`. No other secrets in this environment. Do not put the token in a repository-wide secret or permit arbitrary branch access. Review the protected workflow revision and environment policies first.
4. Only after independent review and verified provider-side spending controls, set repository variables `FACTORY_COPILOT_INCLUDED_ONLY_CONFIRMED=true` and `FACTORY_COPILOT_PILOT_ENABLED=true` (exact lowercase). These owner attestations are not live quota verification or a hard spending limit.
5. From Actions > Factory Copilot hosted pilot, run once on main. No schedule, PR trigger, rerun, or automatic retry. The workflow uses a pinned SHA256-verified official Linux CLI release; the only model call is a fixed synthetic prompt, with no repository checkout, shell/write delegation, raw transcripts or write token. The one-credit CLI limit is a soft guard, not a hard cap. A success marker verifies the response only.
6. Compare personal and organization billing before/after (allow for reporting delay); record actual credits, attribution, zero additional billable spend, runner duration, exact run ID and revision. Disable the opt-in after the experiment; cancel the run and revoke the PAT if anything is unexpected. Missing evidence is a blocker, never a reason to turn on paid usage.

## Subsequent gated rollout

| Stage | Requirement before enabling |
| --- | --- |
| P0 | One synthetic read-only invocation, verified personal entitlement, budget, auth, response and billing evidence |
| P1 | One isolated code worker on approved issue; review input provenance and sandbox; no write credentials in agent environment; validate bounded candidate diff in separate trusted publisher |
| P2 | Atomic repository/issue leases and durable reservation ledger; trusted events, retry/backoff, stale-head checks, stop and independent review; auto-publish only scoped changes |
| P3 | Scale 1/2/4/8/10/12 only from actual concurrent execution and verified remaining quota; native protected merge queue, exact-head CI and verified main |
| P4 | Event-triggered work replenishment and ten-minute best-effort recovery; no laptop or chat dependency; repeatable unattended three-issue pilot |

Do not treat Actions matrices as actual agents, or a successful synthetic response as proof of live coding, billing or quota. A public repository cannot rely on a branch-local self-attestation for trust. Protect the environment, validate every workflow update independently, keep agent credentials isolated from generated code and separate publication from inference. No consumer activation or paid fallback. Existing shadow reconciliation remains unchanged.

Official documentation: https://docs.github.com/en/copilot/how-tos/copilot-cli/automate-copilot-cli/automate-with-actions and https://docs.github.com/en/copilot/concepts/agent-capabilities/agent-powered-workflows-and-operations/copilot-cli-in-github-actions and https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference .
