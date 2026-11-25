# Contributing to SoftwareFactory

Thank you for helping build a reusable, secure engineering factory. Read [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [security policy](SECURITY.md) and the [roadmap](docs/ROADMAP.md) before starting.

## Workflow

1. Find or propose a GitHub issue with measurable acceptance criteria, dependencies, risk and owned paths. Reuse existing issues; do not create duplicate work.
2. Work on a topic branch and open a draft PR. Keep changes small and independently reviewable. Avoid concurrent edits to paths owned by other active PRs.
3. Use synthetic metadata, test fixtures and least privilege. Never copy private consumer data, real credentials, tokens or project-specific product code.
4. Run the full local replay suite and targeted regression tests. Test both valid behavior and failure paths.
5. In the PR, describe issue linkage, scope, limitations, tests and exact commit evidence. Use non-closing linkage for partial implementation. Request independent review; address findings in one consolidated cycle.
6. Merge only through the repository's verified protections with exact-head evidence and applicable authorization. Never activate a consumer, deploy or spend money solely because tests passed.

## Development and quality

Use the pinned Node.js 26.13.1 development and CI baseline. No npm install is required for the current core.

```sh
node --test tests/engineering-factory/*.test.mjs
```

To check coverage locally as in CI, run `npm ci && npm run test:coverage`. This installs the `cobertura` devDependency and writes the gitignored `cobertura-coverage.xml` report.

Target at least 95% source line and 90% source branch coverage per executable component and overall, with measured, reproducible results. Do not claim that thresholds are enforced until actual CI demonstrates this. No blanket exclusions or synthetic success statuses. New code must fail closed on malformed or absent evidence and remain deterministic where possible.

| Area | Required regression examples |
| --- | --- |
| Policy and decisions | Unknown fields, invalid modes, missing evidence, wrong repository or head |
| Review and checks | Stale/dismissed review, wrong producer, changed head, unresolved findings |
| Event adapters (future) | Duplicate delivery, replay, races, permission failure, malformed metadata |
| Budget and ownership | Unknown quota, cap exceeded, overlapping paths, blocked dependencies |
| Security | Untrusted inputs, cross-repo access, injection, redaction, emergency stop |

Workflow and privilege changes require independent security review. No untrusted PR checkout in privileged jobs, no self-issued approvals, and no protections bypass. Preserve license and provenance; only submit contributions you have the right to license under Apache-2.0. See [security reporting](SECURITY.md) for suspected vulnerabilities.

## Documentation

Update behavior, examples, architecture and limitations alongside changes. Label target capabilities separately from implemented features. Use local relative links and accessible diagrams with alt text. Keep examples disabled and synthetic. Document new decisions and version compatibility; do not imply an unreleased commit is a supported release.

## Required engineering expectations

Follow the canonical [engineering standards](docs/ENGINEERING-STANDARDS.md) for exact-head review, measurable PR velocity, per-component and overall coverage, evidence and merge eligibility. Distinguish velocity SLOs from mandatory gates. Keep ownership isolated, preserve stronger consumer policies and document blocked work; no velocity target permits a gate bypass.

## Local runtime standard

Follow [local development and observability](docs/LOCAL-DEVELOPMENT.md): Aspire AppHost and OpenTelemetry/OTLP for runnable components; headless synthetic tests remain mandatory. Do not claim local startup or dashboard evidence until actually verified.
