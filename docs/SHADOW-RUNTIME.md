# Runnable shadow factory (development)

From the repository root with the pinned supported Node runtime:

```sh
node tools/engineering-factory/run.mjs --smoke
node --test tests/engineering-factory/*.test.mjs
```

The smoke uses synthetic approved tasks with explicitly hypothetical capacity. It produces a read-only plan, never an agent assignment. Dependency acceptance, priority, downstream count and nonoverlapping path ownership select ready tasks. It rejects malformed inputs, cycles, unknown capacity and active ownership conflicts. This is not durable scheduling or critical-path duration estimation.

Optional public read-only inventory (network access required):

```sh
node tools/engineering-factory/run.mjs --inventory
```

Only the SoftwareFactory repository is queried, through bounded GET requests; output is limited to issue and PR numbers. No credential is needed or read. Inventory is not trusted merge or dispatch evidence. No live mutations, autonomous providers, persistent leases, event ingestion, Aspire or OTel integration are implemented by this slice. Follow #5/#6/#7/#8/#9/#17 for those requirements. #18 is a later engineering analytics dashboard, not a runtime dependency.
