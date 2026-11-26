# Change-aware validation candidates

The evaluator exposes three offline, shadow-only hints for change-aware feedback, build reuse, and synthetic integration-train comparison. They do not modify workflow selection, execute tests, read or write a cache, retry jobs, or approve integration.

## Fast feedback

`planFastFeedback` accepts a complete path inventory only when its repository, candidate head, base revision, and `trusted-ci` producer marker match the expected snapshot and the evidence is marked verified. The component catalog must name the same repository and base revision, have non-overlapping ownership roots, and provide valid dependency edges and test paths. Missing, stale, incomplete, ambiguous, or unmapped evidence blocks the suggestion.

The `trusted-ci` marker is a data contract, not an authentication mechanism. A future protected workflow adapter must bind it to authoritative GitHub metadata before supplying the evidence. Until that adapter exists, this API is a synthetic evaluator only. Suggested tests are additional fast feedback; `requiredValidation` remains `full` for every result.

## Build reuse

`planBuildReuse` returns a candidate only when a verified `trusted-ci` receipt matches the repository, source head, workflow, dependency, toolchain, and input digests. It never reads or writes cache data. A caller must not treat a candidate as permission to skip any required check; full validation remains required.

## Experiment comparison

`compareTrainExperiment` reports a matched synthetic comparison only when each pair has the same workload, gate set, and accepted work, with no candidate rework or cost regression. It reports the synthetic durations and ratio. These figures do not establish production latency or speedup.

## Acceptance status

This slice is not wired into GitHub Actions. It makes no claim about workflow latency, trusted change evidence, cache-poisoning resistance in a cache service, or end-to-end cost. Those require separate exact-head integration, security review, and measured hosted runs while retaining all required platform, security, coverage, review, and merge-group gates.

