# Delivery lifecycle (target)

![Target issue-to-merge lifecycle](images/lifecycle.svg)

The target control loop is event-driven and dependency-aware, with GitHub as orchestrator. Merged shadow components are tracked in [roadmap v2](ROADMAP.md); actual GitHub-hosted unattended dispatch/integration and durable cross-run state are not yet accepted. A bounded M01 acceptance pilot may execute only after the minimum readiness capabilities (including durable state, protections, quota and stop/recovery) are independently verified and separately scoped live authorization is established. Successful pilot cycles supply M01 acceptance evidence, not the reverse. No laptop or open chat dependency.

| Stage | Input and decision | Exit evidence |
| --- | --- | --- |
| Discover | Trusted repository metadata, approved backlog | Stable issue identity and scope |
| Ready | Dependency, ownership and quota checks | No conflict; owner authorization |
| Active | Supported approved agent dispatch | Idempotent lease and run identity |
| Review | Exact-head tests, independent review, security | Verified check producers and no material findings |
| Eligible | Fresh authoritative head/base and all gates | Decision only, not permission |
| Merge | Separately authorized guarded adapter | Expected-head merge receipt |
| Verify main | Post-merge integration and acceptance | Main green; evidence attached |
| Unblock | Recompute dependencies and queue | Dispatch next eligible work only |

Any changed head, ambiguous evidence, unknown cost, failed main check, stop control or permission error routes to blocked/reconcile. Partial PRs do not close parent acceptance issues. Never bypass repository protections. The scheduler, mutation and main verification adapters require separate implementation and validation.
