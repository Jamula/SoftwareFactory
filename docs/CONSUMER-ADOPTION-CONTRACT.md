# Independent consumer adoption contract (draft)
Contributes to #13, #10, #36, #11, #12. No consumer is activated.

## Required enrollment evidence
| Evidence | Required proof |
|---|---|
| Repository identity | Authoritative stable repository ID, owner, default branch, explicit enrollment decision |
| Implementation | Immutable reviewed factory workflow SHA and matching versioned consumer policy |
| Review | Independent exact-candidate approval, no unresolved threads, trusted check producers |
| Coverage | Actual covered/total source lines and branches for each executable component and overall; consumer baseline minimum 95% source-line and 90% branch coverage in both scopes; SoftwareFactory itself requires 98%/95%; stricter local rules prevail |
| Capacity | Verified included quota and overage controls, repository-specific concurrency and stop switch |
| Access | Separate least-privilege read-only shadow access; no shared admin token |
| Reversibility | Disable enrollment, revoke scoped access, revert pin via reviewed PR, confirm no queued live mutations |

## Independent pilot lanes
- SoftwareFactory: first demonstrate synthetic reusable workflow execution, trusted shadow evidence, expected-head safeguards and rollback.
- FamilyTree (M07, #36; consumer #128/#120): after M05 autonomous self-pilot acceptance, use synthetic data only, retain 95/90 and no product release. No duplicate core.
- Spellbook (M08, #11; consumer #103): preserve 97% app line / 90% branch, WebKit/iOS gates and current two-agent cap until measured capacity approval.
- FamilyHub (M09, #12; consumer #81): verify migrated repository identity and migration readiness separately; preserve existing explicit independent review, required validation, up-to-date and production isolation. Development resumption is not factory activation authorization.

## Verification and negative fixtures
Use synthetic profiles with distinct repository IDs and independent policies. Test wrong identity, stale pin, missing check producer, stale/dismissed review, exhausted or unknown quota, revoked enrollment and rollback. Every unknown fails closed. Do not copy credentials, live policy from PR heads or private data. No live dispatch, merge, deployment or extra spending without separate verified authority.
