# Durable local shadow host (M02.04 / M02.05)

The opt-in local host connects the existing SQLite event journal and bounded
public metadata readers. It recovers one pending PR claim before ingesting a
new observation, rotates one open PR per poll, and records a deduplicated
receipt keyed by repository, PR, candidate, base, state and draft status.
A PR-only one-row cursor advances each tick and wraps at the end; at most
three GET attempts per tick reserve both identity reads, with no issue inventory.
A ten-minute wait bounds work; this is a rotating recovery sample, not complete check/review evidence or a latency
guarantee. Unsuccessful claims stay fenced until expiry. No credentials, live
dispatch, merge, provider reservations, billing access or cloud resources.

After independent review, an owner can explicitly run the exported
`runLocalShadowHost` on an existing authorized persistent host with
`enabled:true`, an owner-controlled private durable database path, a unique
worker ID, an AbortSignal, and trusted clock. Abort propagates into active GETs and prevents subsequent journal writes; restart with
the same database. Do not run from consumer PRs or privileged workflows.
Use Aspire for the eventual managed host and verify actual host availability,
storage ownership, stop/restart, cost and recovery before declaring #5/#6
accepted. This PR does not provision or start a host.

Unsupported event kinds remain unacknowledged for their own consumers. The pull-only claim filter retains repository-wide exclusivity. Rejected PR identities advance the cursor without enqueueing. Pre-aborted hosts do not open storage.

Rejected pending pulls stay unacknowledged with a durable one-hour retry deferral separate from the active lease. Other eligible pulls can proceed after lease expiry. Invalid owner IDs stop before storage opens. Deferral is not reconciliation success.

Eligible claims are ordered by durable retry eligibility time, then original ID; never-deferred work is ahead of deferred retries. Every normal recovery tick (including an unacknowledged rejected identity) reserves a separate bounded inventory page and identity read. When recovery used the tick's claim, any fresh inventory hint is enqueued for later, not immediately claimed. Receipts retain the recovery result and separate inventoryReason. Stop, clock, storage, and failed-deferral states still fail closed. Regression covers six permanent failures and later valid work over four hours with reopened storage.
