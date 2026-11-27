# Durable shadow event journal

The local SQLite event journal retains sanitized reconciliation hints across restarts. It stores a configured repository ID, a delivery ID, an event kind, a numeric subject and an observed head. For a repository-wide hint, use subject zero. A delivery replay with the same metadata returns a duplicate receipt. Conflicting metadata with the same repository and delivery ID is rejected. Insertion order determines which hint gets work first.

Use the journal only behind a trusted event adapter, with an owner-controlled local database path. An event is a request to fetch fresh metadata. The stored head never authorizes a decision. After a successful fresh read and reconciliation, the runtime may acknowledge the claim. It must leave unsuccessful attempts unacknowledged for recovery.

A claim is atomic and exclusive per repository. Other repositories can continue concurrently. An expired claim can be recovered with a new generation. Use a consistent trusted clock across local workers. Acknowledgement requires the current owner, generation, and unexpired lease. A successful acknowledgement leaves a receipt for duplicate detection. At 10,000 deliveries for a repository the journal rejects new entries and keeps prior receipts. Retention and rotation need a policy before sustained use.

This API is shadow-only (`liveDispatch: false`, `liveMerge: false`). Ephemeral GitHub Actions runner disks are not authoritative cross-run lease stores on their own; hosted production execution still requires an independently reviewed, cost-verified durable backing store (#6).

## Deterministic cross-run snapshots (`exportJournalSnapshot` / `importJournalSnapshot`)

`exportJournalSnapshot(journal, {repositoryId})` exports an insertion-ordered, frozen `schemaVersion: 1` snapshot of sanitized journal entries (`repositoryId`, `deliveryId`, `kind`, `subject`, `head`, `owner`, `generation`, `expires`, `completed`, `retryAfter`, with `retryAfter` always cleared to `null` once `completed` is `true`). Optional `repositoryId` scoping exports only one repository's entries while rejecting malformed scope objects, non-positive IDs, getters, and proxies. Because journal capacity is bounded at 10,000 entries per repository and snapshot imports accept at most 10,000 entries, unscoped exports exceeding 10,000 rows fail closed with `SNAPSHOT_LIMIT`; multi-repository hosts must export per-repository snapshots.

`importJournalSnapshot(journal, snapshot, {now = 0})` validates the entire snapshot and clock atomically before applying `BEGIN IMMEDIATE ... COMMIT`:
- Rejects proxies, accessors, invalid clocks (`CLOCK_UNKNOWN`), sparse or >10,000-entry arrays, unknown fields, duplicate `(repositoryId, deliveryId)` pairs inside the snapshot, unclaimed entries with owners/leases/completion/deferrals, completed entries with active leases or deferrals, and entries that would exceed the 10,000-entry per-repository cap (`JOURNAL_FULL`).
- Rejects any incoming entry whose `(kind, subject, head)` conflicts with an existing `(repositoryId, deliveryId)` receipt (`DELIVERY_CONFLICT`), rolling back the transaction with zero partial mutation.
- Enforces repository-wide lease exclusivity against the trusted `now` clock (`LEASE_CONFLICT` rollback whenever more than one uncompleted entry in a repository holds `expires > now`, including newly imported or generation-advanced claims) and clears `expires = 0` on expired uncompleted leases when an active lease is present in the same repository.
- Preserves monotonic fencing and completion when replaying into a populated journal: completed receipts never reopen, higher generations advance lower uncompleted claims without regressing newer generations, and `retryAfter` merges monotonically.

## Scoped fresh-read reconciliation (`reconcileJournalOnce` and `reconcileEventTrigger`)

The `reconcileJournalOnce` shadow helper consumes one claim at a time, reads normalized fresh metadata, checks lease time and repository/kind/subject, and completes only the current fenced claim. A freshly observed moved head supersedes the old hint (`SHADOW_HEAD_SUPERSEDED`) without granting any action. Failed or unknown evidence leaves the claim unacknowledged (or durably deferred via `deferUnknown`) for recovery.

`createScopedJournalReader` and `reconcileEventTrigger` in `tools/engineering-factory/event-envelope.mjs` connect trusted GitHub event normalization (`pull`, `issue`, `manual`, `review`, `check`, and `main`) to `event-journal.mjs` using bounded unauthenticated public GitHub REST reads and optional cross-run snapshot import/export. All outputs remain read-only shadow receipts (`evidenceComplete: false`, `liveDispatch: false`, `liveMerge: false`).
