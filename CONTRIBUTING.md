# Contributing

Keep changes portable and independently reviewable. Do not introduce consumer
data, secrets, credentials, or project-specific code. Changes to any workflow,
policy, event adapter, or decision path require security review and must retain
read-only behavior unless a separately approved scope explicitly says otherwise.

## Requirements and tests

- Node.js 20 or later; no package installation is required to run the plain
  test suite.
- Run `node --test tests/engineering-factory/*.test.mjs`.
- To check coverage locally (matches CI): `npm ci && npm run test:coverage`.
  This installs the single zero-dependency `cobertura` devDependency and
  writes a gitignored `cobertura-coverage.xml` Cobertura report.
- Verify that examples remain synthetic and disabled.
- Explain security implications and provenance for changes derived from
  another repository.

No CI or production activation is implied by passing the synthetic replay.
