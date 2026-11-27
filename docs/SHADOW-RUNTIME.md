# Runnable shadow factory (development)

From the repository root with the pinned supported Node runtime:

```sh
node tools/engineering-factory/run.mjs --smoke
node --test tests/engineering-factory/*.test.mjs
```

The smoke uses synthetic approved tasks with explicitly hypothetical capacity. It produces a read-only plan, never an agent assignment. Dependency acceptance, priority, downstream count and nonoverlapping path ownership select ready tasks. It rejects malformed inputs, cycles, unknown capacity and active ownership conflicts. This is not durable scheduling or critical-path duration estimation.

## Durable shadow coordinator, bounded execution TTL, and cross-run recovery

For lane-fenced shadow scheduling, scheduling diagnostics, bounded inspection deadlines, and cross-run state recovery:

```sh
node --test tests/engineering-coordinator/*.test.mjs
```

- `tools/engineering-coordinator/planner.mjs` provides `planLanes`, `diagnosePlan`, and `pathsOverlap`. It validates DAG acyclicity, lane path ownership, active reservations, optional risk ceilings, and priority aging, ordering ready candidates by effective priority, readiness timestamp, longest unfinished dependency chain, transitive unfinished descendant fan-out, and deterministic task ID. `diagnosePlan` emits per-task critical-path depth, descendant fan-out, aging boost, unaccepted dependencies, `PATH_OVERLAP` vs `LANE_RESERVED` conflict attributions, and lane-capacity utilization.
- `tools/engineering-coordinator/coordinator.mjs` (`runTick`) remains strictly shadow-only (`liveDispatch: false`, `liveMerge: false`) and enforces a bounded lane execution deadline (`maxExecutionMs`, defaulting to `3 * config.limits.leaseMs`) across both authoritative `tracker.readTask` calls and `agent.inspect`. Timed-out task reads release cleanly, whereas if `agent.inspect` stalls past the deadline or timer budget, `runTick` aborts the inspection `AbortSignal`, stops heartbeat lease renewals, leaves the uncertain in-flight lease to expire rather than releasing early, and returns deterministic `EXECUTION_TIMEOUT` so orphaned lane and issue leases can be reclaimed after expiry.
- `tools/engineering-coordinator/sqlite-state-store.mjs` (`exportSnapshot` / `importSnapshot`) exports canonical, SHA-256 integrity-checked, generation-fenced snapshots of lanes (including per-generation `checkpointRevision` stored in a separate `coordinator_lane_checkpoints` table so existing 4-column `coordinator_lane_work` schemas remain rollback-compatible), paired work reservations, and unexpired external reservations. `importSnapshot` fails closed on malformed records (`INVALID_SNAPSHOT`), digest mismatches (`SNAPSHOT_TAMPERED`), stale snapshot or per-lane/work/checkpoint revisions (`STALE_GENERATION`), clock rollback (`CLOCK_ROLLBACK`), and active local lease or combined reservation-capacity collisions (`ACTIVE_OWNERSHIP_CONFLICT`), enabling cross-run recovery across stateless GitHub-hosted runners without assuming unverified caches are atomic.

Optional public read-only inventory (network access required):

```sh
node tools/engineering-factory/run.mjs --inventory
```

Only the SoftwareFactory repository is queried, through bounded GET requests; output is limited to issue and PR numbers. No credential is needed or read. Inventory is not trusted merge or dispatch evidence. No live mutations, autonomous providers, persistent leases, event ingestion, Aspire or OTel integration are implemented by this slice. Follow #5/#6/#7/#8/#9/#17 for those requirements. #18 is a later engineering analytics dashboard, not a runtime dependency.
