# Portable Engineering Coordinator

The coordinator separates reusable orchestration from project policy. The prompt is shared at `agents/engineering-coordinator.md`; strict project settings live in `config/` and are validated independently; the runtime-independent modules under `tools/engineering-coordinator/` accept adapters rather than importing a provider SDK.

## Boundaries

- `project-config.mjs` validates an explicit, closed configuration shape. Unknown properties, overlapping path owners, unsafe values and unsupported adapter kinds fail closed.
- `planner.mjs` is deterministic and side-effect free. It rejects unknown or cyclic dependencies, active path conflicts and tasks outside their configured lane; active inventory reserves its lane, paths and concurrency slot, with at most one scheduled task per lane.
- `retry.mjs` provides a bounded exponential delay with jitter and honors a provider retry-after value. If the requested delay exceeds the configured window, it fails closed instead of retrying early. Only explicitly classified transient failures retry. `readAfterUncertainWrite` awaits its authoritative comparison, accepts only literal `true`, and never repeats the write itself.
- `provider-adapters.mjs` wraps injected read-only work-tracker and agent inspection interfaces. It rejects sparse or malformed findings. Dispatch is hard-disabled.
- `coordinator.mjs` runs independent lanes with per-lane failure isolation, renews its lease using a fresh injected clock before inspection and checkpointing, rechecks authoritative task state before checkpointing, and returns shadow evidence only.
- `sqlite-state-store.mjs` is the Node.js persistence adapter, including fenced lease renewal. The orchestration and decision modules do not import Node or SQLite APIs.

The example project config is disabled (`enabled: false`, `stop: true`), uses mock adapters, and limits concurrency to one. The implementation has no live GitHub transport, agent dispatch, merge, deployment, credentials, or provider permission changes. The project must separately verify included capacity and authorize any future live capability.

## Local use

Validate a loaded JSON configuration with `validateProjectConfig`, pass synthetic tasks to `planLanes`, and inject mock tracker/agent adapters, a fresh clock function, and a SQLite state store into `runTick`. The store path should be local and access-controlled. Close the store when the process exits. Use `node --test tests/engineering-coordinator/*.test.mjs` for the isolated component suite and `npm run test:coverage` for the repository aggregate.

Current state is shadow-only. The hourly coordinator remains the existing external supervisor; this component does not create a schedule, activate a second worker, or claim that Work mode supplies persistent execution.
