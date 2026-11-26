# Aspire consumer reference and M02 metric evidence

This is a reference pattern only, not consumer enrollment or activation. Use the immutable, reviewed factory pin and consumer-specific policy. Preserve all stricter coverage, review, platform, authorization, isolation and budget gates. No new credentials, paid services, deployment or remote collector is authorized.

## Reproduce the synthetic reference

1. Use the pinned Node, .NET, Aspire CLI and npm lock from the reviewed candidate. Restore with `npm ci --ignore-scripts`; run `npm run test:coverage`.
2. Start an isolated AppHost with trusted development TLS, local-only authenticated dashboard and numeric-loopback OTLP HTTP/protobuf endpoint. Do not override TLS verification or publish resource environment data.
3. Explicitly start the default-off synthetic process. Require STOPPED and LOCAL_SDK_SHUTDOWN_COMPLETE, followed by a bounded clean stop. No live provider, GitHub writes, or dispatch.
4. From the authenticated dashboard, confirm service softwarefactory-shadow, span factory.evaluate, correlated factory.stage.completed structured log and both factory.stage.count and factory.stage.duration metrics. Use the fixed evaluate/blocked/POLICY dimensions. The synthetic run must contain exactly one evaluation.
5. For metrics, use the dashboard's Manage logs and telemetry export UI: select only the metric data for this isolated run; save privately in runner-temporary storage. Extract only the metric OTLP JSON files locally, without following archive paths or publishing raw data. Invoke `node tests/engineering-factory/verify-dashboard-metrics.mjs <metric-json-file> [additional-metric-json-files]`. A zero exit code validates the expected counter and histogram values, service and scope; it cannot itself establish export provenance. Record exact commit, platform, run identity, authenticated dashboard provenance and sanitized result; delete raw files. A synthetic parser fixture is not receipt evidence.
6. Record the exact candidate, trusted checks, source counts, independent review, protected integration and main health separately. A failed or missing signal blocks #17 acceptance.

The CLI and HTTP telemetry read APIs document trace and log access but do not list a metric query. The authenticated dashboard UI supports metrics export. Aspire 17 also documents local SQLite storage of metric points; a future unattended readback may use a version-pinned, read-only query of a fresh isolated synthetic run after independently verifying the schema. Do not inspect unrelated runs, dump database contents, or treat a transport acknowledgement as persistence proof. The live hosted-runner metric receipt is not yet verified.

References: https://aspire.dev/dashboard/explore/ ; https://aspire.dev/dashboard/apis/ ; https://aspire.dev/dashboard/data-persistence/ .

## Consumer boundary

Keep evaluation deterministic and free of telemetry side effects; attach explicit local exporters in the adapter or runner only. Inject synthetic provider inputs and fixed low-cardinality metric labels. Use per-consumer isolated credentials supplied by the local AppHost, never embedded, logged or exported. Retain the consumer's language/runtime and separate authorization; this reference does not require a rewrite. Consumers must demonstrate their own locked restore, exact-head validation, dashboard auth, clean shutdown, telemetry receipt and rollback before any activation.
