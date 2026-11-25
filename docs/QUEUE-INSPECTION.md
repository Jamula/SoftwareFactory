# M04 protected queue inspection (#4, #8, #10, #16)
Read-only diagnostic lane, not a merge controller or activation. On an already authenticated local GitHub CLI, inspect a PR using:
```sh
gh pr view 37 --repo Jamula/SoftwareFactory --json number,headRefOid,baseRefName,state,isDraft,reviewDecision,mergeStateStatus,autoMergeRequest,statusCheckRollup
gh api repos/Jamula/SoftwareFactory/rules/branches/main
gh api repos/Jamula/SoftwareFactory/branches/main/protection
```
The last endpoint may require privileges; failure means protection evidence is unknown. Inspect effective rulesets and legacy branch protection separately. A COMMENTED review is not APPROVED; aggregate reviewDecision is not proof of independent exact-head approval. A CLEAN merge state is not proof of required check producers, coverage, security, or queue enrollment. autoMergeRequest being present is not a merge receipt. Preserve expected-head guards, independently verified rules, required checks, stop, authorization, quota and no-bypass policy before any write. No credentials, permission changes, queue writes, new service or spending in this lane. The pure queueInspection helper classifies diagnostic snapshots only. Run its component coverage and full suite before opening a PR; no actual CLI execution or live eligibility proof yet.
