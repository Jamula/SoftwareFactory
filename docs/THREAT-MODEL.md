# Threat model

Scope: the shared evaluator, planned trusted event adapter and any future repository-scoped dispatch or merge adapter. Current evaluation is read-only and synthetic; none of the future adapter controls is asserted to be implemented.

| Threat | Required mitigation and verification |
| --- | --- |
| Prompt/command injection from issues, reviews or artifacts | Treat content as inert data, structured validation, no shell interpolation; hostile input regression |
| Malicious fork or PR policy | Trusted default-branch policy, immutable pins, no privileged untrusted checkout; prove fork and changed-policy denial |
| Forged/stale review or check | Exact head and trusted producer identity, latest effective review, unresolved threads, fresh authoritative reads; changed/dismissed head tests |
| TOCTOU merge race | Serialize reconciliation, re-read evidence, expected-head merge and server protections; concurrent head change test |
| Duplicate events or agent leases | Durable idempotency and bounded retries; duplicate/reordered event replay |
| Cross-repository privilege escalation | Independent allowlists and scoped credentials, no global admin token; wrong repository rejection |
| Cost runaway | Verified quotas, explicit authorization and stop controls; missing or exhausted budget blocks |
| Data exposure in logs | Minimize metadata, sanitize reason codes, no payloads or secrets; adversarial redaction tests |
| Supply-chain compromise | Immutable reviewed action/workflow pins, independent security review, no automatic upgrades; dependency review |
| Partial acceptance or failed main | Keep parent issue open, block dependent dispatch, report failure; post-merge failure replay |

Security approval must be independent of the implementation agent. Synthetic flags cannot authorize a real mutation. See [security policy](../SECURITY.md) for reporting.
