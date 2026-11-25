# Quickstart: run the current shadow foundation

**No GitHub credential, cloud service, agent subscription or production repository is needed to run the synthetic replay.**

1. Clone `https://github.com/Jamula/SoftwareFactory.git` and check out the reviewed commit you intend to inspect. Development PR branches are not releases.
2. Install a supported Node.js LTS (the current code requires Node.js 20+).
3. From the repository root run:

```sh
node --version
node --test tests/engineering-factory/*.test.mjs
```

Inspect `tools/engineering-factory/core.mjs` and the synthetic `example-policies.json`. The evaluator accepts caller-provided policy and normalized snapshots; tests demonstrate decision behavior, not trusted live evidence. See [policy guide](POLICY.md).

Expected: tests complete with no failures. A shadow decision may be blocked, disabled or eligible based on supplied evidence; it never dispatches, approves or merges anything. Do not turn a synthetic eligible result into an actual merge.

If files are missing, confirm the commit contains the foundation PR; if the test fails, inspect the first failure and Node version. Do not skip tests to get a green result. Next read [workflow guide](WORKFLOWS.md) and [consumer onboarding](CONSUMER-ONBOARDING.md).

## Aspire and OpenTelemetry

The required future local entry point is Aspire AppHost. It is not yet implemented; continue using the headless test command above. See [local development](LOCAL-DEVELOPMENT.md) for the planned contract, tracked work and verification criteria. Do not attempt an undocumented launch command.
