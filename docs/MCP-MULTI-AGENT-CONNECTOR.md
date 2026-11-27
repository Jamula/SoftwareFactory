# MCP Server and Multi-Agent Isolation Connector (`M02.06` / `#136`)

This document defines SoftwareFactory's versioned, read-only, deterministic **MCP Server and Multi-Agent Connector** (`tools/engineering-factory/mcp-agent-connector.mjs`, `CONNECTOR_PROTOCOL_VERSION = "1.0.0"`, `MCP_PROTOCOL_VERSION = "2025-06-18"`).

> **Scope and activation status:** Shadow/read-only contract only (`M02.06`, P2, [#136](https://github.com/Jamula/SoftwareFactory/issues/136)). Merging this module does not enable live external provider credentials, metered API spending, autonomous merge rights, or external telemetry export. GitHub (`github/gh-aw` + Copilot Cloud Agent/Automations + GitHub Native Squash Merge Queue) remains the primary outer orchestrator and execution baseline.

---

## Architectural Boundaries

1. **External deterministic merge authority (`externalMergeAuthorityOnly: true`):**
   - No AI model, MCP tool, `.NET` `AIAgent`, Codex action, or Claude session can merge a pull request, issue a synthetic approval, or edit protected control-plane files (`FORBIDDEN_CONTROL_PLANE_PATHS`, including `.github/workflows`, `.lock.yml`, `.github/rulesets`, `config/policy`, `core.mjs`, `protected-squash.mjs`, `coverage-evidence.mjs`, and `platform-merge-gates.mjs`).
   - All merge-eligibility decisions remain outside every agent loop in `tools/engineering-factory/core.mjs` (`evaluate`) and `tools/engineering-factory/protected-squash.mjs` (`guardedSquashEvidence`) feeding **GitHub Native Squash Merge Queue**.
2. **Read-only stateless JSON-RPC `2.0` surface:**
   - Payloads are capped at `65,536` UTF-8 bytes (`MAX_MCP_REQUEST_BYTES`), rejecting oversized envelopes (`-32600`) and malformed JSON (`-32700`) before evaluation.
   - All inputs pass Proxy-first (`types.isProxy(v)` checked prior to `Array.isArray(v)`), prototype-exact (`Object.prototype` / `Array.prototype`), own-enumerable-data-descriptor validation so untrusted getters, Proxies, sparse arrays, and `__proto__` gadgets never execute.
   - Every exposed tool carries `annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }`.

---

## JSON-RPC `2.0` MCP Protocol Surface

`handleMcpConnectorRequest(rawOrObject, context)` handles standard JSON-RPC `2.0` envelopes and notifications (`id === undefined` returns `null`):

| Method | Purpose | Response Contract |
| --- | --- | --- |
| `initialize` | Negotiate MCP `2025-06-18` capabilities | Returns `{ protocolVersion: "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "softwarefactory-mcp-connector", version: "1.0.0" } }` |
| `ping` | Liveness check | Returns `{}` |
| `tools/list` | Enumerate read-only tools | Returns the 4 frozen tool descriptors with strict JSON Schemas (`additionalProperties: false`) |
| `tools/call` | Invoke a read-only tool | Returns `{ isError, content: [{ type: "text", text }], structuredContent }`; fails closed with `CONNECTOR_STOPPED` if `context.killSwitch` or `context.stop` is active |

### Read-Only Tools (`tools/call`)

1. **`get_repo_knowledge_map`**:
   - Validates `repositoryId` (and optional `repository` / `revision`) against `context.authorizedRepositories`. Cross-repository queries, missing authorization contexts, or `Jamula/SoftwareFactory` repository-ID mismatches (`1471342715`) fail closed (`UNAUTHORIZED_REPOSITORY`, `CROSS_REPO_ACCESS_DENIED`, `REPOSITORY_IDENTITY_MISMATCH`).
   - Enforces `98%` line / `95%` branch coverage floors on `Jamula/SoftwareFactory` and `95%` line / `90%` branch (or stricter consumer policy, such as `97%/92%`) on enrolled consumers (`COVERAGE_FLOOR_VIOLATION` on any attempt to lower floors).
   - Returns sanitized lane ownership, component boundaries (via `softwareFactoryCatalog` or `validateProjectConfig` + `validateKnowledgeMap`), and immutable `architectureInvariants`.
2. **`evaluate_gate_status`**:
   - `mode: "candidate"` delegates to `evaluate` (`core.mjs`); `mode: "protected-squash"` delegates to `guardedSquashEvidence` (`protected-squash.mjs`).
   - Stamps `externalMergeAuthorityOnly: true`, `liveMerge: false`, and `allowDirectMergeOrPolicyWrite: false` on every response.
3. **`get_bounded_work_item_context`**:
   - Validates W3C Trace Context `traceparent` (`00-<32 lowercase hex>-<16 lowercase hex>-<2 lowercase hex>`, rejecting all-zero `traceId` or `parentId` with `INVALID_TRACEPARENT`).
   - Rejects (`secretHandling: "reject"`, default) or redacts (`secretHandling: "strip"`) secret-like tokens (`ghp_`, `ghs_`, `github_pat_`, `sk-`, `sk-ant-`, `Bearer `) without false-positiving hyphenated English terms such as `task-1` or `risk-class`.
   - Rejects any `ownedPaths` overlapping `FORBIDDEN_CONTROL_PLANE_PATHS` or `.lock.yml` (`FORBIDDEN_CONTROL_PLANE_PATH`), returning bounded `{ ownedPaths, forbiddenControlPlanePaths, maxRepairIterations }`.
4. **`validate_provider_isolation`**:
   - Executes `validateMultiAgentConnectorConfig(arguments)` for `github-copilot`, `openai-codex`, or `anthropic-claude` adapters.

---

## `.NET 10` `Microsoft.Extensions.AI` (`IChatClient`) & `Microsoft.Agents.AI` Bridge

In `M02`, inner specialist orchestration runs on `.NET 10` with **Microsoft Agent Framework** (`Microsoft.Agents.AI` and `Microsoft.Agents.AI.Workflows` `1.28.0+` GA, paired with `Microsoft.Agents.AI.GitHub.Copilot` and local **Aspire 17** `ActivitySource` OTLP spans):

- `Microsoft.Extensions.AI.IChatClient` and `AIAgent` workers consume SoftwareFactory's MCP tools as read-only context providers (`adapter: "microsoft-agents-ai-ichatclient"` or `"microsoft-extensions-ai-ichatclient"`).
- Note that GitHub Models was retired in July 2026; `IChatClient` pipelines bind only to supported Copilot (`Microsoft.Agents.AI.GitHub.Copilot`) or separately owner-authorized vendor adapters that pass `validateMultiAgentConnectorConfig`.
- Local OpenTelemetry spans stay confined to the authenticated loopback Aspire Dashboard; third-party cloud tracing remains disabled (`telemetryExportAllowed: false`).

---

## Provider Isolation Rules & `$0` Unapproved Spend Gate

Every connector configuration must declare `externalMergeAuthorityOnly: true`, `allowDirectMergeOrPolicyWrite: false`, and `unapprovedSpendUsdCents: 0` (`UNAPPROVED_SPEND_FORBIDDEN` otherwise). Raw credential tokens in `env` or checkpoint metadata are rejected fail-closed (`SECRET_MATERIAL_REJECTED`).

| Provider Family | Supported Adapters | Mandatory Isolation & Budget Invariants |
| --- | --- | --- |
| `github-copilot` (default) | `copilot-cloud-agent`, `microsoft-agents-ai-ichatclient`, `microsoft-extensions-ai-ichatclient` | `includedQuotaVerified === true`, `overageHardStopUsdCents === 0` (GitHub Billing `$0` overage hard-stops on AI Credits, Premium Requests, and Cloud Sandboxes/Actions), `unapprovedSpendUsdCents === 0`. |
| `openai-codex` | `openai-codex-action`, `openai-agents-sdk`, `microsoft-extensions-ai-ichatclient` | `ownerAuthorized === true`, `unapprovedSpendUsdCents === 0`, `env.OPENAI_AGENTS_DISABLE_TRACING === "1"` (fails closed with `EXTERNAL_TRACING_NOT_DISABLED` if missing or not `"1"`), `externalTelemetryDisabled === true`, and `trustedBaseConfigRestored === true` (restoring `.codex/` configuration from the trusted base branch before execution so untrusted PR branches cannot tamper with sandbox or network settings). |
| `anthropic-claude` | `claude-code-action`, `claude-agent-sdk`, `microsoft-extensions-ai-ichatclient` | `ownerAuthorized === true`, `unapprovedSpendUsdCents === 0` (owner-verified included capacity such as `CLAUDE_CODE_OAUTH_TOKEN` or explicitly capped budget, never embedded in metadata), `preToolUseOnFailure === "block"` (fails closed with `PRE_TOOL_HOOK_NOT_FAIL_CLOSED` if `"ignore"` or omitted), `externalTelemetryDisabled === true`, `trustedBaseConfigRestored === true`, and optional `SessionStore` `sessionCheckpoint` integrity (`64`-hex SHA-256 `sha256`, matching `40`-hex `headSha`, and cryptographic digest verification when `serializedState` is supplied). |

---

## Instant Rollback to Copilot-Only Execution

`createCopilotOnlyRollbackState(reason)` provides deterministic single-step rollback whenever an external vendor adapter experiences quota exhaustion, hook/tracing misconfiguration, or operator revocation:

- Immediately sets `externalConnectorsEnabled: false` and `disabledProviders: ["openai-codex", "anthropic-claude"]`.
- Preserves `activeProviderFamily: "github-copilot"` and `preserveCopilotExecution: true` so `M01` (`gh-aw` + Copilot Cloud Agent/Automations) and `M02` (`.NET 10` MAF + Copilot) continue unaffected.
- Emits a pre-validated frozen `fallbackConfig` (`copilot-cloud-agent`, `overageHardStopUsdCents: 0`, `unapprovedSpendUsdCents: 0`) and automatically redacts any accidental secret-like token in `reason` to `REDACTED_ROLLBACK_REASON`.

## Local Validation

```bash
npm run test:coverage
```
