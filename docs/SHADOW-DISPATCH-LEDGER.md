# Shadow dispatch reservations

The SQLite ledger exercises reservation and reconciliation for M02.08 and [#7](https://github.com/Jamula/SoftwareFactory/issues/7). It has no provider client. Every result sets `liveDispatch` to false.

Open a private local file with a fixed synthetic capacity plan. The plan binds the included-unit ceiling, units per attempt, total active limit, repository limits, and a window identifier. Every process opening the same file must use the same plan. A mismatch fails closed. Reservations and active counts are computed under a SQLite write transaction, so competing workers cannot both reserve the final slot. The same repository, issue, and head stay recorded across lease generations. Another head for the same issue cannot be reserved while an attempt is active. The ledger refuses new records after 10,000 rows.

- **Reserve:** Supply normalized, repository-scoped approval and current lease evidence, plus included-only quota observed within 60 seconds. The quota snapshot describes synthetic external activity and units before adding this ledger's reservations. Unknown quota, enabled overage, a stop, or expired lease denies the reservation.
- **Record a dry run:** Supply fresh local lease and stop evidence for the same repository, issue, head, and generation. The ledger only records an in-flight simulation. It refuses evidence older than five seconds or an expired reservation.
- **Cancel before simulation:** This returns the slot and its units. The exact candidate stays fenced against duplicate attempts.
- **Reconcile a recorded simulation:** An independently obtained synthetic terminal receipt must match every ticket identifier. This frees the active slot and retains spent units. Unknown results stay charged and block duplicate attempts across restarts. A completed or in-flight attempt is never refunded automatically.

Run `node --test tests/engineering-factory/shadow-dispatch-ledger.test.mjs` to exercise the fixtures. The caller owns authoritative identity, clock, and quota normalization. This local ledger does not establish current provider entitlement, supported authentication, real cancellation, a persistent runtime, or a safe policy for rotating windows and reconciling unknown receipts. Leave #7 open until those prerequisites and explicit repository-scoped authorization are verified.
