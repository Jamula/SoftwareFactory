# SoftwareFactory milestone roadmap: 25× program

Owner direction: design for 25× verified engineering throughput, deliver incrementally and prove gains without reducing correctness, security, privacy, authorization, or cost controls. The original 10× objective is an intermediate milestone, not a measured achievement. All dates are provisional Pacific-time planning windows from November 24, 2026; all future windows have low confidence until dependencies, capacity and evidence are verified. Do not conflate implementation, review, merge, activation and final acceptance.

## Milestones

| ID | Scope | GitHub tracking | ETA (PT) | Exit criteria / dependencies |
| --- | --- | --- | --- | --- |
| M01 | Repository setup | Repository settings | Complete Nov 24, 2026 | Apache-2.0, public, main, squash only, auto-merge enabled at repository level; operational queue unverified |
| M02.01 | Shared foundation and docs | [#1](https://github.com/Jamula/SoftwareFactory/issues/1), [PR #2](https://github.com/Jamula/SoftwareFactory/pull/2), [PR #3](https://github.com/Jamula/SoftwareFactory/pull/3) | Nov 25–27, 2026 | Port, provenance, current-head tests and review; integrate docs; keep umbrella acceptance open |
| M02.02 | Automated quality and review gates | [#4](https://github.com/Jamula/SoftwareFactory/issues/4) | Nov 27–Dec 1 | Actual candidate-head CI, >=95% lines / >=90% branches, trusted review evidence |
| M02.03 | Aspire AppHost local development and dashboard | [#17](https://github.com/Jamula/SoftwareFactory/issues/17) | Nov 28–Dec 3, 2026 | #1/#4/#9; synthetic local smoke, Windows verification, local OTLP |
| M03.01 | Trusted event/metadata adapter | [#5](https://github.com/Jamula/SoftwareFactory/issues/5) | Dec 2–9 | #1/#4; zero-mutation shadow and trusted provenance |
| M03.02 | Critical-path queue, leases and ownership | [#6](https://github.com/Jamula/SoftwareFactory/issues/6) | Dec 2–12 | Foundation; agree adapter contracts; idempotency, concurrency and failure replay |
| M03.03 | Agent dispatch and budget controls | [#7](https://github.com/Jamula/SoftwareFactory/issues/7) | Dec 9–Jan 6, 2027 | #5/#6; supported provider and verified included quota; mocks first |
| M03.04 | Review and guarded merge controller | [#8](https://github.com/Jamula/SoftwareFactory/issues/8) | Dec 9–Jan 6 | #4/#5/#6; exact-head verification, main health and authorization; shadow first |
| M03.05 | OpenTelemetry, metrics and retrospective experiments | [#9](https://github.com/Jamula/SoftwareFactory/issues/9) | Dec 2–16, 2026 | Agreed event schema; real baseline and sanitized measurements |
| M04 | Autonomous SoftwareFactory self-pilot (overriding P0) | [#10](https://github.com/Jamula/SoftwareFactory/issues/10) | Jan 6–20, 2027 (provisional; pull forward when ready) | M02/M03 and minimum #15/#16 readiness; three verified unattended cycles, zero routine human intervention, 120s eligible batch target |
| M05 | FamilyTree independent pilot | [#36](https://github.com/Jamula/SoftwareFactory/issues/36) | Jan 20–Feb 3, 2027 (provisional) | M04 accepted; FamilyTree #128/#120 readiness, separately authorized immutable pin |
| M06 | Spellbook pilot | [#11](https://github.com/Jamula/SoftwareFactory/issues/11) | Jan 20–Feb 3 | #10/#36 and consumer readiness; stricter gates and independent pin |
| M07 | Family Hub pilot | [#12](https://github.com/Jamula/SoftwareFactory/issues/12) | TBD; Feb 2027 earliest planning window | #10/#36, migration readiness and separate activation approval, exact-head approval gate verified |
| M08 | Reusable onboarding and component catalog | [#13](https://github.com/Jamula/SoftwareFactory/issues/13) | Jan 13–Feb 3 | M03 contracts; independently pinned, synthetic consumer profiles |
| M09.01 | Knowledge index, decomposition, specialists | [#14](https://github.com/Jamula/SoftwareFactory/issues/14) | Jan 20–Feb 17 | #6/#7/#13; controlled experiments |
| M09.02 | Change-aware CI, cache, failure diagnosis | [#15](https://github.com/Jamula/SoftwareFactory/issues/15) | Jan 20–Feb 17 | #4/#9; equivalent full verification |
| M09.03 | Integration trains and portfolio optimization | [#16](https://github.com/Jamula/SoftwareFactory/issues/16) | Feb 3–Mar 3 experiments; 25× TBD | #8/#9/#10/#14/#15; measured accepted work, unchanged quality and cost controls |
| M09.04 | Engineering intelligence dashboard | [#18](https://github.com/Jamula/SoftwareFactory/issues/18) | TBD; first local view after M04/#9 | Read-only historical OTel aggregates, baseline comparison, throughput, efficiency, quality and cost; separate from Aspire diagnostics |

Parent M02: Nov 25–Dec 3, 2026 (conditional on Aspire verification). Parent M03: Dec 2–Jan 6, 2027, conditional on provider evidence. Parent M09: Jan 20–Mar 3 for experiments, not a 25× completion promise. M04 is the priority. M05 FamilyTree is the first external pilot; M06 Spellbook and M07 Family Hub prepare independently but activate only after M04/M05 acceptance and their own verified readiness. M08 and safe synthetic M09 design work can overlap. Missing prerequisites move the ETA, not the quality gate.

## Throughput stages

| Stage | Target vs measured baseline | Required demonstration |
| --- | --- | --- |
| S01 | 2× | Baseline plus reduced idle / rework |
| S02 | 5× | Event-driven shadow and authorized scheduling, parallel review |
| S03 | 10× | Guarded integration and pilot, unchanged quality |
| S04 | 15× | Specialist routing and fresh repository knowledge |
| S05 | 20× | Contract-first decomposition and reusable components |
| S06 | 25× | Portfolio allocation and controlled continuous optimization |

Stage targets are hypotheses, not dates or permission to scale agent concurrency. Measure comparable accepted work/day, failure/rework, p50/p95 latency, actual cost and security outcomes. No raw PR volume proxy. Retain verified per-repo concurrency caps and fail closed on unknown budget. The 20–50 logical lane aspiration is not an authorized active agent count.

No live mutations, new credentials, paid services, production releases, protection changes or consumer activation without separately verified authority. Remain shadow-only until all required evidence passes. See [engineering standards](ENGINEERING-STANDARDS.md), [architecture](ARCHITECTURE.md) and [security policy](../SECURITY.md).

Tracking: milestone IDs and ETA windows live on the issues and in this roadmap. They are logical groupings, not native GitHub milestone records; the currently available integration cannot create native milestones.

## Engineering intelligence dashboard

M09.04 measures verified accepted work, actual speedup, agent utilization, latency distributions, quality, cost and bottlenecks by authorized repository and time window. Aspire Dashboard is for local resource and telemetry diagnostics; the later portfolio dashboard is for durable historical engineering analytics. Use the #9 metric contract, #17 local development standard and #10 pilot evidence. No dashboard work blocks the first usable factory. ETA is TBD until baseline data and retention are verified. Synthetic and real metrics must be labeled separately; missing evidence is unknown. See [#18](https://github.com/Jamula/SoftwareFactory/issues/18).
