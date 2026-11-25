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
