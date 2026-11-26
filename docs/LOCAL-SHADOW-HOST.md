# Durable local shadow host (M02.04 / M02.05)

The opt-in local host connects the existing SQLite event journal and bounded
public metadata readers. It recovers one pending PR claim before ingesting a
new observation, rotates one open PR per poll, and records a deduplicated
receipt keyed by repository, PR, candidate, base, state and draft status.
Eight public GET attempts per tick and a ten-minute wait bound work; this is
a rotating recovery sample, not complete check/review evidence or a latency
guarantee. Unsuccessful claims stay fenced until expiry. No credentials, live
dispatch, merge, provider reservations, billing access or cloud resources.

After independent review, an owner can explicitly run the exported
`runLocalShadowHost` on an existing authorized persistent host with
`enabled:true`, an owner-controlled private durable database path, a unique
worker ID, an AbortSignal, and trusted clock. Stop by aborting; restart with
the same database. Do not run from consumer PRs or privileged workflows.
Use Aspire for the eventual managed host and verify actual host availability,
storage ownership, stop/restart, cost and recovery before declaring #5/#6
accepted. This PR does not provision or start a host.
