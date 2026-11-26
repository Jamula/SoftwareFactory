# Durable shadow event journal

The local SQLite event journal retains sanitized reconciliation hints across restarts. It stores a configured repository ID, a delivery ID, an event kind, a numeric subject and an observed head. For a repository-wide hint, use subject zero. A delivery replay with the same metadata returns a duplicate receipt. Conflicting metadata with the same repository and delivery ID is rejected. Insertion order determines which hint gets work first.

Use the journal only behind a trusted event adapter, with an owner-controlled local database path. An event is a request to fetch fresh metadata. The stored head never authorizes a decision. After a successful fresh read and reconciliation, the runtime may acknowledge the claim. It must leave unsuccessful attempts unacknowledged for recovery.

A claim is atomic and exclusive per repository. Other repositories can continue concurrently. An expired claim can be recovered with a new generation. Use a consistent trusted clock across local workers. Acknowledgement requires the current owner, generation, and unexpired lease. A successful acknowledgement leaves a receipt for duplicate detection. At 10,000 deliveries for a repository the journal rejects new entries and keeps prior receipts. Retention and rotation need a policy before sustained use.

This API is local and shadow-only. A trusted-ingress and reconciliation loop must wire it in before the journal handles real deliveries.

The injected `reconcileJournalOnce` shadow helper consumes one claim at a time, reads normalized fresh metadata, checks lease time and repository/kind/subject, and completes only the current fenced claim. A freshly observed moved head supersedes the old hint without granting any action. Failed evidence leaves the claim unacknowledged for recovery. A real trusted read adapter, transport freshness proof, clock and bounded scheduler still need wiring; the boolean fresh assertion is a synthetic fixture contract, not authentication.
