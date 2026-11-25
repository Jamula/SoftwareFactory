# Milestone roadmap

ETAs are provisional planning estimates from 2026-11-25, not commitments.
Confidence is low until the required owners and security reviewers confirm
scope, access, and evidence sources. No release or activation is authorized.

| Milestone | Scope | Provisional ETA | Confidence | Exit criteria |
| --- | --- | --- | --- | --- |
| M0 — portable foundation | Versioned strict policy, pure fail-closed evaluator, synthetic replay, provenance, docs | 2026-11-25 | Medium | Exact-source review, replay, and measured component coverage |
| M1 — metadata-only adapter | Trusted default-branch workflow/event boundary, fresh read-only metadata, idempotency, serialized reconciliation, sanitized telemetry | 2026-12-09 | Low | Threat model, synthetic replay, zero-mutation proof, independent exact-head security review |
| M2 — consumer validation | Independent synthetic profiles and read-only tests; baseline/target throughput methodology | 2026-12-16 | Low | Consumer owners validate their own policy and gates; measured data only |
| M3 — guarded activation design | Reusable workflow and independently pinned consumer configuration; authorization, quotas, branch protections, kill switch | 2027-01-06 | Low | Separate owner approvals and verified supported permissions; otherwise remain shadow-only |

No milestone assumes new credentials, paid services, deployments, private
consumer data, or cross-repository rollout. Family Hub adoption must wait for
its migration freeze to be lifted by its owner. An auto-merge setting is not
activation approval. Any live dispatch or merge capability requires a distinct
approved scope and independent security review.
