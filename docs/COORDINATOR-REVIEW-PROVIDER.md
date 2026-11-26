# Review provider contract (#8)

The reusable coordinator now has a provider-neutral, shadow-only review request adapter.
It accepts an exact repository/PR/head candidate and authoritative normalized review
state. Pending or already reviewed heads are not requested again. An externally
verified, atomic reservation scoped to that candidate must attest included capacity
and disabled overage; repository configuration never grants this authority.

The real Copilot API is documented at https://docs.github.com/en/rest/pulls/copilot-code-review :
POST /repos/{owner}/{repo}/pulls/{pull_number}/copilot-code-review (API version
2026-03-10). The eventual host must map current reviews and pending requests to the
normalized state, keep review effort and billing policy separately configured, and
verify the final exact-head reviewer evidence independently. A request receipt is
not a completed review. The endpoint has no caller-supplied expected-head precondition;
a host must re-read before dispatch and validate the returned review commit after.
Unknown outcomes must not be blindly resubmitted, even across restarts.

The mock adapter uses the existing bounded read retry and uncertain-write
reconciliation helpers. It simulates 201, 409, 422, 403, 429 and 503; pending conflict
requires a fresh matching read, and transient write failures defer rather than repeat
a potentially billable request. The host still needs a durable reservation/intent
ledger, billing and stop-path verification, scheduling and an authorized authenticated
transport. This slice sends no network request, changes no credentials or settings,
and does not close #8 or enable live review dispatch. Review credits and Actions
minutes must both be verified before actual use.
