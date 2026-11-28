# MCP Server and Multi-Agent Isolation Connector (`M02.06` / `#136`)

This document defines SoftwareFactory's versioned, read-only, deterministic **MCP Server and Multi-Agent Connector** (`tools/engineering-factory/mcp-agent-connector.mjs`, `CONNECTOR_PROTOCOL_VERSION = "1.0.0"`, `MCP_PROTOCOL_VERSION = "2025-06-18"`).

> **Scope and activation status:** Shadow/read-only contract only (`M02.06`, P2, [#136](https://github.com/Jamula/SoftwareFactory/issues/136)). Merging this module does not enable live external provider credentials, metered API spending, autonomous merge rights, or external telemetry export. GitHub (`github/gh-aw` + Copilot Cloud Agent/Automations + GitHub Native Squash Merge Queue) remains the primary outer orchestrator and execution baseline.

---

## Running the stdio server

From the repository root, run `node bin/softwarefactory-mcp.mjs` or `npm run mcp`.
The executable is also registered as `softwarefactory-mcp` in `package.json`.
The process exchanges one JSON-RPC message per line on stdin and stdout; stdout
is reserved for protocol messages. Use `node` directly (or `npm run --silent mcp`)
for protocol clients, since npm's normal script banner can pollute stdout.
No additional npm runtime dependency is needed.
The workspace registration in `.vscode/mcp.json` starts the same server in VS Code.

For Copilot CLI, add an entry to `~/.copilot/mcp-config.json`, replacing the
path with the absolute path to this checkout:

```json
{
  "mcpServers": {
    "softwarefactory": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/SoftwareFactory/bin/softwarefactory-mcp.mjs"],
      "tools": ["*"]
    }
  }
}
```

Other MCP stdio clients, including Copilot App, Copilot Coding Agent, Claude
Code, Codex, and .NET `IChatClient` MCP integrations, can launch the same
command using their respective client configuration. Client and provider
authorization, entitlement, and budget checks remain separate.

The CLI enrolls only `Jamula/SoftwareFactory` (repository ID `1471342715`);
this is a read-only context, not permission to dispatch, merge, or access
consumer repositories. Knowledge-map requests still require a revision and a
freshness timestamp. Results are advisory and do not replace trusted evidence,
independent review, or consumer-specific gates.

---

## Architectural Boundaries

1. **External deterministic merge authority (`externalMergeAuthorityOnly: true`):**
   - No AI model, MCP tool, `.NET` `AIAgent`, Codex action, or Claude session can merge a pull request, issue a synthetic approval, or edit protected control-plane files (`FORBIDDEN_CONTROL_PLANE_PATHS`, including `.github/workflows`, `.lock.yml`, `.github/rulesets`, `.github/softwarefactory-policy.json`, `config/policy`, `core.mjs`, `protected-squash.mjs`, `coverage-evidence.mjs`, `platform-merge-gates.mjs`, `review-history.mjs`, `review-batch.mjs`, `budget.mjs`, and `mcp-agent-connector.mjs`).
   - All merge-eligibility decisions remain outside every agent loop in `tools/engineering-factory/core.mjs` (`evaluate`) and `tools/engineering-factory/protected-squash.mjs` (`guardedSquashEvidence`) feeding **GitHub Native Squash Merge Queue**.
2. **Read-only stateless JSON-RPC `2.0` surface:**
   - Payloads are capped at `65,536` UTF-8 bytes (`MAX_MCP_REQUEST_BYTES`), rejecting oversized envelopes (`-32600`) and malformed JSON (`-32700`) before evaluation.
   - All inputs pass Proxy-first (`types.isProxy(v)` checked prior to `Array.isArray(v)`), prototype-exact (`Object.prototype` / `Array.prototype`), own-enumerable-data-descriptor validation so untrusted getters, Proxies, sparse arrays, and `__proto__` gadgets never execute.
   - Every exposed tool carries `annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }`.

---

## JSON-RPC `2.0` MCP Protocol Surface & Framed Stdio Transport

`handleMcpConnectorRequest(rawOrObject, context)` handles standard JSON-RPC `2.0` envelopes, optional validated `_meta` request metadata (`initialize`, `ping`, `tools/list`, and `tools/call`), and notifications (`id === undefined` always returns `null` without unsolicited error responses, even when notification `params` are invalid).

`processMcpFramedMessages(lines, context)` provides a deterministic, bounded newline-delimited JSON-RPC `2.0` batch/stdio processor ready for MCP stdio pipes (`.NET` `IChatClient` MCP clients, `openai/codex-action`, and `anthropics/claude-code-action`):

- Accepts either a dense plain array of single-line JSON strings or a `\n` / `\r\n`-delimited stream chunk, enforcing `MAX_MCP_FRAMED_LINES = 100` (`FRAMED_BATCH_LIMIT_EXCEEDED` above `100` lines), rejecting empty batches (`EMPTY_FRAMED_BATCH`) and embedded `\r` / `\n` frame-injection characters (`EMBEDDED_NEWLINE_IN_FRAME`), and validating `context` fail-closed (`INVALID_CONNECTOR_CONTEXT`).
- Enforces `MAX_MCP_REQUEST_BYTES = 65,536` UTF-8 bytes per line (`-32600` `PAYLOAD_TOO_LARGE` without parsing oversized frames), omits responses for JSON-RPC notifications, and escapes `\u2028` / `\u2029` so every entry in `responses` (and `framedOutput`) is guaranteed newline-free.

| Method | Purpose | Response Contract |
| --- | --- | --- |
| `initialize` | Negotiate MCP `2025-06-18` capabilities | Returns `{ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "softwarefactory-mcp-connector", version: "1.0.0" } }` |
| `ping` | Liveness check | Returns `{}` |
| `tools/list` | Enumerate read-only tools | Returns the 8 read-only tool descriptors and their input schemas |
| `tools/call` | Invoke a read-only tool | Returns `{ isError, content: [{ type: "text", text }], structuredContent }`; fails closed with `CONNECTOR_STOPPED` if `context.killSwitch` or `context.stop` is active |

### Read-Only Tools (`tools/call`)

1. **`get_repo_knowledge_map`**:
   - Validates `repositoryId` (and optional `repository` / `revision`) against `context.authorizedRepositories`. Cross-repository queries, missing authorization contexts, `defaultBranch` conflicts between enrollment and `projectConfig` (`BRANCH_METADATA_CONFLICT`), or `Jamula/SoftwareFactory` repository-ID mismatches (`1471342715`) fail closed (`UNAUTHORIZED_REPOSITORY`, `CROSS_REPO_ACCESS_DENIED`, `REPOSITORY_IDENTITY_MISMATCH`).
   - Requires an explicit safe-integer freshness clock from `args.nowMs` or `context.nowMs` (never substituting `generatedAtMs`), failing closed with `FRESHNESS_TIMESTAMP_REQUIRED` if omitted or `CLOCK_MISMATCH` if caller and trusted context disagree.
   - Enforces `98%` line / `95%` branch coverage floors on `Jamula/SoftwareFactory` and `95%` line / `90%` branch (or stricter consumer policy, such as `97%/92%`) on enrolled consumers (`COVERAGE_FLOOR_VIOLATION` on any attempt to lower floors).
   - Returns sanitized lane ownership, component boundaries (via `softwareFactoryCatalog` with `tests/engineering-factory/mcp-agent-connector.test.mjs` included in the test inventory, or `validateProjectConfig` + `validateKnowledgeMap`), and immutable `architectureInvariants`.
2. **`evaluate_gate_status`**:
   - Enforces the enrolled repository's `coverageThresholds` (including stricter consumer gates such as `97%/92%`, plus `98%/95%` on `Jamula/SoftwareFactory` and `95%/90%` baseline) against `args.policy` (`mode: "candidate"`) and `args.evidence.policy` (`mode: "protected-squash"`) before delegating to `evaluate` (`core.mjs`) or `guardedSquashEvidence` (`protected-squash.mjs`).
   - Stamps `externalMergeAuthorityOnly: true`, `liveMerge: false`, and `allowDirectMergeOrPolicyWrite: false` on every response.
3. **`get_bounded_work_item_context`**:
   - Validates W3C Trace Context `traceparent` (`00-<32 lowercase hex>-<16 lowercase hex>-<2 lowercase hex>`, rejecting all-zero `traceId` or `parentId` with `INVALID_TRACEPARENT`).
   - Rejects (`secretHandling: "reject"`, default) or redacts (`secretHandling: "strip"`) secret-like tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`, `sk-`, `sk-ant-`, and case-insensitive HTTP `Bearer ` schemes such as `Bearer`, `BEARER`, `bEaReR`) in text fields without false-positiving hyphenated English terms such as `task-1` or `risk-class`, and unconditionally rejects secret-bearing `ownedPaths` or `additionalForbiddenPaths` in both `"reject"` and `"strip"` modes (`SECRET_TOKEN_REJECTED`).
   - Rejects any `ownedPaths` overlapping `FORBIDDEN_CONTROL_PLANE_PATHS` or `.lock.yml` (`FORBIDDEN_CONTROL_PLANE_PATH`), returning bounded `{ ownedPaths, forbiddenControlPlanePaths, maxRepairIterations }`.
4. **`validate_provider_isolation`**:
   - Executes `validateMultiAgentConnectorConfig(arguments)` for `github-copilot`, `openai-codex`, or `anthropic-claude` adapters.
5. **`plan_disjoint_lanes`**:
   - Plans non-overlapping lane ownership and task dependencies without dispatching agents.
6. **`build_consumer_onboarding_plan`**:
   - Builds and evaluates read-only consumer onboarding evidence without enrolling or activating a consumer.
7. **`select_scoped_guidance_and_lessons`**:
   - Selects guidance and lessons within the supplied scope; selection is not authorization.
8. **`get_factory_board_snapshot`**:
   - Provides an informational read-only factory board snapshot when a trusted read-only transport is explicitly injected. The default CLI does not make live provider calls and fails closed when that transport is unavailable; board data does not authorize actions.

---

## `.NET 10` `Microsoft.Extensions.AI` (`IChatClient`) & `Microsoft.Agents.AI` Bridge

In `M02`, inner specialist orchestration runs on `.NET 10` with **Microsoft Agent Framework** (`Microsoft.Agents.AI` and `Microsoft.Agents.AI.Workflows` `1.28.0+` GA, paired with `Microsoft.Agents.AI.GitHub.Copilot` and local **Aspire 17** `ActivitySource` OTLP spans):

- `Microsoft.Extensions.AI.IChatClient` and `AIAgent` workers consume SoftwareFactory's MCP tools as read-only context providers (`adapter: "microsoft-agents-ai-ichatclient"` or `"microsoft-extensions-ai-ichatclient"`).
- Note that GitHub Models was retired in July 2026; `IChatClient` pipelines bind only to supported Copilot (`Microsoft.Agents.AI.GitHub.Copilot`) or separately owner-authorized vendor adapters that pass `validateMultiAgentConnectorConfig`.
- Local OpenTelemetry spans stay confined to the authenticated loopback Aspire Dashboard; third-party cloud tracing remains disabled (`telemetryExportAllowed: false`).

---

## Provider Isolation Rules & `$0` Unapproved Spend Gate

Every connector configuration must declare `externalMergeAuthorityOnly: true`, `allowDirectMergeOrPolicyWrite: false`, and `unapprovedSpendUsdCents: 0` (`UNAPPROVED_SPEND_FORBIDDEN` otherwise). Raw credential tokens and separator-normalized / compact case-insensitive credential and authorization keys (`authorization`, `authheader`, `access_token`, `api_key`, `APIKey`, `APIKEY`, `CLIENTSECRET`, `token`, and any `*token` alias except MCP `progressToken`, including `GH_TOKEN`, `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GITHUB_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) across configs, `env`, and MCP `_meta` are rejected fail-closed (`SECRET_MATERIAL_REJECTED` / `INVALID_MCP_META`). Included subscription / OAuth capacity is represented exclusively via boolean metadata (`includedQuotaVerified === true` or `oauthEntitlementVerified === true`, rejecting `false` with `OAUTH_ENTITLEMENT_UNVERIFIED` and non-booleans with `INVALID_OAUTH_ENTITLEMENT`).

| Provider Family | Supported Adapters | Mandatory Isolation & Budget Invariants |
| --- | --- | --- |
| `github-copilot` (default) | `copilot-cloud-agent`, `microsoft-agents-ai-ichatclient`, `microsoft-extensions-ai-ichatclient` | `includedQuotaVerified === true`, `overageHardStopUsdCents === 0` (GitHub Billing `$0` overage hard-stops on AI Credits, Premium Requests, and Cloud Sandboxes/Actions), `unapprovedSpendUsdCents === 0`, optional `oauthEntitlementVerified === true`. |
| `openai-codex` | `openai-codex-action`, `openai-agents-sdk`, `microsoft-extensions-ai-ichatclient` | `ownerAuthorized === true`, `unapprovedSpendUsdCents === 0`, `includedQuotaVerified === true` or `oauthEntitlementVerified === true` (or explicit `authorizedSpendCapUsdCents > observedSpendUsdCents` with verified remaining cap), `env.OPENAI_AGENTS_DISABLE_TRACING === "1"` (fails closed with `EXTERNAL_TRACING_NOT_DISABLED` if missing or not `"1"`), `externalTelemetryDisabled === true`, and `trustedBaseConfigRestored === true` (restoring `.codex/` configuration from the trusted base branch before execution so untrusted PR branches cannot tamper with sandbox or network settings). |
| `anthropic-claude` | `claude-code-action`, `claude-agent-sdk`, `microsoft-extensions-ai-ichatclient` | `ownerAuthorized === true`, `unapprovedSpendUsdCents === 0`, `includedQuotaVerified === true` or `oauthEntitlementVerified === true` (or explicit `authorizedSpendCapUsdCents > observedSpendUsdCents` with verified remaining cap; OAuth/API secrets never embedded in metadata), `preToolUseOnFailure === "block"` (fails closed with `PRE_TOOL_HOOK_NOT_FAIL_CLOSED` if `"ignore"` or omitted), `externalTelemetryDisabled === true`, `trustedBaseConfigRestored === true`, and optional `SessionStore` `sessionCheckpoint` integrity requiring `serializedState` bytes (`CHECKPOINT_STATE_MISSING` if omitted), `64`-hex SHA-256 cryptographic digest verification, and matching `40`-hex `headSha`. |

---

## Heterogeneous Cross-Model Independent Review & Specialist Fallback

`evaluateCrossModelReviewEligibility(input)` validates heterogeneous multi-vendor review (`mode: "independent-review"`, default) and specialist worker fallback (`mode: "specialist-fallback"`):

- **True cross-model independence:** Requires `reviewerProvider !== authorProvider` OR case-normalized `reviewerModelFamily !== authorModelFamily` (`SELF_MODEL_REVIEW_FORBIDDEN` on self-model review, and `SELF_IDENTITY_REVIEW_FORBIDDEN` if optional `authorIdentity` and `reviewerIdentity` match).
- **Dual harness & entitlement verification:** Validates both `authorConfig` and `reviewerConfig` through `validateMultiAgentConnectorConfig` (reporting `failedSide: "author" | "reviewer"`), checks provider alignment (`PROVIDER_CONFIG_MISMATCH`), role separation (`INVALID_AUTHOR_ROLE`, `INVALID_REVIEWER_ROLE`), exact candidate `headSha` binding (requiring `input.headSha`, `authorConfig.headSha`, and `reviewerConfig.headSha` to all be present and identical in `"independent-review"` mode via `CANDIDATE_HEAD_SHA_REQUIRED` / `CROSS_MODEL_HEAD_MISMATCH`, while preserving optional aligned `headSha` in `"specialist-fallback"`), verified subscription/OAuth metadata (`oauthEntitlementVerified === true` or `includedQuotaVerified === true` or remaining `authorizedSpendCapUsdCents`) with zero raw secrets (`SECRET_MATERIAL_REJECTED`), and `$0` unapproved spend.
- **Sole external merge authority & instant rollback:** Requires `externalMergeGateAuthoritative === true` (`EXTERNAL_MERGE_AUTHORITY_REQUIRED`), keeps `tools/engineering-factory/core.mjs` and `tools/engineering-factory/protected-squash.mjs` as the sole merge authority (`syntheticApprovalAllowed: false`, `liveMerge: false`), and attaches a frozen Copilot-only fallback via `createCopilotOnlyRollbackState` (activating immediately on `rollbackToCopilotOnly`, `killSwitch`, `stop`, or any harness/isolation failure without fabricating Copilot budget evidence).

---

## Instant Rollback to Copilot-Only Execution

`createCopilotOnlyRollbackState(reason, verifiedCopilotBudget)` provides deterministic single-step rollback whenever an external vendor adapter experiences quota exhaustion, hook/tracing misconfiguration, or operator revocation:

- Immediately sets `externalConnectorsEnabled: false` and `disabledProviders: ["openai-codex", "anthropic-claude"]`.
- Preserves `activeProviderFamily: "github-copilot"` without fabricating Copilot budget evidence: when previously verified Copilot budget evidence (`includedQuotaVerified === true`, `overageHardStopUsdCents === 0`, `unapprovedSpendUsdCents === 0`) is supplied, `fallbackConfig` remains execution-ready (`budgetVerified: true`, `budgetRevalidationRequired: false`); when omitted or unverified, `fallbackConfig` sets `includedQuotaVerified: false`, `overageHardStopUsdCents: null`, and `budgetRevalidationRequired: true` so `validateMultiAgentConnectorConfig` fails closed until Copilot budget is re-verified.
- Automatically redacts any accidental secret-like token in `reason` to `REDACTED_ROLLBACK_REASON`.

## Local Validation

```bash
npm run test:coverage
```
