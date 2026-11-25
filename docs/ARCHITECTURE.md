# Architecture (0.1.0)

## Current boundary

`tools/engineering-factory/core.mjs` accepts a caller-provided version-1 policy
and normalized metadata snapshot. `validPolicy` rejects unknown policy keys
and malformed policy fields. `evaluate` returns a frozen, fixed-shape
`{ state, reason, shadow }` result; it performs no I/O and cannot mutate GitHub.
Missing or contradictory evidence blocks eligibility. Policy values and
snapshot flags are inputs, not verified evidence: in particular,
`policySource: "trusted-default-branch"` is only a caller assertion.

The input contract checks repository and exact head/base identity, branch,
budget and concurrency, provider availability, risk, changed-path ownership,
dependencies, acceptance, base/main health, thread/security status, coverage
head and thresholds, check names and producer app IDs, and exact-head
independent review evidence. Ambiguous review history fails closed. A result of
`eligible` is a synthetic shadow decision, never an approval, check, permission,
or instruction to dispatch or merge.

`example-policies.json` and replay fixtures use only fictional repositories and
identities. The `disabled` mode and kill switch are on in every example.
`ONBOARDING.txt` records the operator constraints and current missing
capabilities.

## Not implemented

There is no trusted event/API adapter, durable idempotency store, per-repository
serialization, dependency graph/cycle detector, queue or dispatch, live
authoritative evidence acquisition, or sanitized telemetry pipeline. The
reusable workflow runs only this repository's pinned synthetic tests; it does
not inspect consumer PR metadata or execute consumer code. The evaluator's
input checks do not prove that a snapshot came from a trusted source. Do not
use it to authorize actions.

Those features require separately reviewed, least-privilege implementation and
validation before activation. In particular, never check out or execute
untrusted pull-request code in a privileged workflow, never trust policy from a
PR head, and never synthesize approvals or check results.

The reusable test workflow itself must also be referenced by immutable full
commit SHA. The synthetic example configuration under `docs/` is pinned to
workflow commit `fbecbf99b4c8e1696194bd6fa5220b2328cd1379` and grants no write
permissions. It is not an enabled configuration for any actual consumer.

## Consumer model

FamilyTree is the first intended consumer; Spellbook and Family Hub must adopt
independently, pinned to a reviewed immutable SoftwareFactory commit. Each
consumer owns its trusted policy and retains its own branch protections,
security and coverage gates, review rules, budgets, and release process.
Family Hub migration readiness and separate consumer activation approval remain required. Repository identity alone,
existing auto-merge settings, and a shadow result grant no permissions.

## Required local runtime design (planned)

Aspire AppHost will orchestrate the synthetic shadow runner and local authenticated dashboard. Instrument runner/adapter boundaries with OpenTelemetry and use local OTLP; keep evaluator pure. No public endpoint, external telemetry or live provider access. See [local development](LOCAL-DEVELOPMENT.md) and issues #17/#9. Existing architecture remains read-only synthetic until verified.
