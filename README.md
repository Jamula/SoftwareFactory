# SoftwareFactory

Shared, policy-driven engineering-factory core. This repository currently
contains a deterministic, read-only shadow evaluator and synthetic policies;
it is not an operational controller and cannot dispatch work, approve or merge
pull requests, or mutate GitHub.

The initial evaluator and replay tests were ported from
[Jamula/FamilyTree commit `1b871b76895f0d4943eda441a3295e843a127f58`](https://github.com/Jamula/FamilyTree/tree/1b871b76895f0d4943eda441a3295e843a127f58).
See [NOTICE](NOTICE) for provenance and license details.

## Development

- Requires Node.js 20 or later; there are no npm dependencies.
- Run the synthetic replay: `node --test tests/engineering-factory/core.test.mjs`
- Review [architecture](docs/ARCHITECTURE.md), [onboarding](tools/engineering-factory/ONBOARDING.txt),
  and the [roadmap](docs/ROADMAP.md) before considering any consumer adoption.

All example repositories, identities, check names, app IDs, budgets and gates
are synthetic. No consumer is enabled. Shadow eligibility is not approval or
authorization to take an action.
