# SoftwareFactory

**One shared engineering engine. Independent project execution.**

SoftwareFactory is an Apache-2.0, policy-driven foundation for an event-driven autonomous software delivery system. The goal is to reduce idle time between approved issues, implementation, validation, review and integration without weakening project-specific security, quality or release gates.

> **Current maturity: 0.1.0 development, shadow orchestration and read-only adapters.** GitHub is the required orchestrator; supported hosted execution and durable cross-run state must work with the owner's laptop offline. Actual autonomous dispatch, protected unattended integration and accepted throughput still require M01 evidence. An eligible shadow result is not authorization. The 25× program is a stretch hypothesis, not a benchmark result.

![Target architecture: one shared versioned core with independently pinned consumer adapters, project policy and CI](docs/images/architecture.svg)

## Start here

| I want to… | Read |
| --- | --- |
| Aspire local development and OpenTelemetry | [Local development and observability](docs/LOCAL-DEVELOPMENT.md) |
| Run the current evaluator locally | [Quickstart](docs/QUICKSTART.md) |
| Understand how the system works | [Architecture](docs/ARCHITECTURE.md), [delivery lifecycle](docs/DELIVERY-LIFECYCLE.md) |
| Integrate a repository without enabling writes | [Consumer onboarding](docs/CONSUMER-ONBOARDING.md) |
| Use or build GitHub workflows | [Workflow guide](docs/WORKFLOWS.md) |
| Understand policy and evidence | [Policy guide](docs/POLICY.md) |
| Operate, pause and troubleshoot | [Operations](docs/OPERATIONS.md) |
| Report a security issue | [Security policy](SECURITY.md), [threat model](docs/THREAT-MODEL.md) |
| Engineering standards, PR velocity and quality gates | [Engineering standards](docs/ENGINEERING-STANDARDS.md) |
| Contribute | [Contributing](CONTRIBUTING.md), [agent rules](AGENTS.md) |
| Track what is implemented | [Roadmap](docs/ROADMAP.md), [documentation index](docs/README.md) |

## Engineering expectations

| Metric | Objective |
| --- | --- |
| Source line / branch coverage | >=98% / >=95% for SoftwareFactory per component and overall; consumer-specific gates remain independent |
| Eligible work dispatch / merge | p95 <=2 minutes each |
| Full required automated CI | p50 <75 seconds from candidate event to last required check |
| Small PR turnaround | p50 <=10 minutes from creation to merge; verified main separately |
| Security bypass / duplicate dispatch / unapproved spending | Zero |

These are documented standards and targets, not verified automation capabilities. See [Engineering standards](docs/ENGINEERING-STANDARDS.md) for precise measurement and mandatory gates.

## Delivery milestones

M01 autonomous SoftwareFactory; M02 fast SoftwareFactory; M03 FamilyTree; M04 Spellbook; M05 FamilyHub. See [roadmap v2](docs/ROADMAP.md) for entry/exit criteria and historical mapping. Speed is not an autonomy prerequisite, and Rust is an optional benchmark, not a rewrite mandate.

## Optional local development

Use Node.js 26.13.1, the pinned development and CI LTS baseline. No npm dependencies are required by the current evaluator.

```sh
node --test tests/engineering-factory/*.test.mjs
```

For an overall Cobertura coverage report, use the CI-pinned Node.js 26.13.1 and run `npm ci --ignore-scripts && npm run test:coverage`. This installs the locked `cobertura` development dependency and writes the gitignored `cobertura-coverage.xml`. Node.js 20 does not support the coverage flags. CI retains the independent per-component gates and runtime smoke tests; the report does not replace them.

The tests replay synthetic policy and evidence snapshots. All sample repository identities, check producers and quotas are fictional. A passing replay does not prove live repository safety, credentials, branch protection or budget.

## Target delivery loop

![Proposed issue-to-merge lifecycle with review and fail-closed gates](docs/images/lifecycle.svg)

Consumers adopt independently, pin immutable reviewed workflow revisions and retain their own CI, permissions, budgets and kill switches. FamilyTree is the intended first pilot; Spellbook and Family Hub follow after their own readiness checks. No project is enabled by this documentation.

## License and provenance

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE). The initial evaluator and replay tests were ported from [FamilyTree commit 1b871b76895f0d4943eda441a3295e843a127f58](https://github.com/Jamula/FamilyTree/tree/1b871b76895f0d4943eda441a3295e843a127f58). Preserve applicable attribution.

## Platform standards

Aspire AppHost is the local development and hosted synthetic runtime standard; OpenTelemetry/OTLP is the observability standard. GitHub-hosted Linux and Windows runtime evidence exists for earlier revisions; final acceptance remains tracked in [#17](https://github.com/Jamula/SoftwareFactory/issues/17) and [#9](https://github.com/Jamula/SoftwareFactory/issues/9). No laptop or always-on local host is required. See [local development](docs/LOCAL-DEVELOPMENT.md).
