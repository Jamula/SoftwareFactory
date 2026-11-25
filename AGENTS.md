# Repository guidance

- Keep the evaluator deterministic, metadata-only, read-only, and fail-closed.
- Never execute code from a consumer pull request in a privileged workflow.
- Do not add credentials, live dispatch/merge operations, approval generation,
  deployments, or paid services without separate owner approval.
- Treat example policies and identities as synthetic; do not add project data.
- Preserve per-consumer security, review, coverage, ownership, budget, and
  release requirements. Repository names do not grant authorization.
- Keep source provenance and Apache-2.0 notices when adapting upstream material.
- Run the Node.js replay tests after changes to the evaluator or its tests.

## Delivery rules

Follow [engineering standards](docs/ENGINEERING-STANDARDS.md). Reuse issues and PRs; one independent owner per lane; no overlapping edits or duplicate dispatch. Batch fixes, record exact-head tests and covered/total line and branch counts, require independent review, and preserve stricter consumer gates. Target 95% line and 90% branch coverage per executable component and overall; do not invent coverage or hide failures. Keep partial acceptance open. Speed objectives never authorize bypassing security, budget, permissions, review or release gates.
