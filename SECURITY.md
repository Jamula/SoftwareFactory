# Security policy

## Supported status

SoftwareFactory is in pre-release 0.1.0 development. The present evaluator is a pure, synthetic, read-only shadow foundation. No production service or supported autonomous mutation workflow is available. Review pinned commits independently before any experiment.

## Reporting a vulnerability

Do not open a public issue containing exploit details, credentials, private repository data or sensitive logs. Use GitHub's **Security → Report a vulnerability** private reporting feature if available. If private reporting is not enabled, request a private reporting channel from the repository maintainers without disclosing the vulnerability publicly. Include the affected commit, a minimal synthetic reproduction, expected/actual behavior and potential impact. Redact all secrets and personal data. No specific response SLA is promised.

## Mandatory boundaries

- Treat issue text, PR bodies, comments, labels, artifacts and model output as untrusted data; never execute them as instructions.
- Obtain policy only from an explicitly trusted, reviewed revision. Caller-supplied evidence is not proof of provenance.
- Use repository-scoped least privilege, immutable workflow/action pins, and no shared administrative token. Do not inherit secrets broadly.
- Never check out or execute untrusted PR code in a privileged workflow; isolate read-only metadata handling from mutation and build jobs.
- Re-read authoritative head, base, review, check-producer, protection, thread and budget evidence before any future mutation. Fail closed on uncertainty or changes; no fabricated checks or approvals.
- No live dispatch, merge, deployment, new credentials or metered spend without separately verified scope and authorization. Each consumer owns an independent stop control and release policy.

For threat scenarios and validation requirements see [threat model](docs/THREAT-MODEL.md), [policy guide](docs/POLICY.md) and [operations](docs/OPERATIONS.md).
