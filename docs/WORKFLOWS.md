# GitHub workflow guide

## Current implementation

The draft foundation provides `.github/workflows/shadow-tests.yml`, a reusable **synthetic replay** workflow called through `workflow_call`, and [an example caller](consumer-shadow-tests.yml). It grants contents read permission, checks out pinned SoftwareFactory test code with credential persistence disabled and runs synthetic tests. It does not inspect consumer PR data, run consumer source, dispatch agents, publish required approval checks or merge anything.

A consumer caller must pin a **reviewed, available full SHA** that contains the tested reusable workflow. The following is intentionally a non-runnable template until the placeholder is replaced:

```yaml
name: SoftwareFactory synthetic replay
on:
  pull_request:
  workflow_dispatch:
permissions:
  contents: read
jobs:
  replay:
    uses: Jamula/SoftwareFactory/.github/workflows/shadow-tests.yml@REPLACE_WITH_REVIEWED_FULL_SHA
```

Review both the called workflow revision and the checkout revision it uses; they are separate pins. Verify the intended test files actually run. Do not treat a replay job as a required product security/approval check or automatically copy secrets into it.

## Future event-driven controller

| Event category | Planned response |
| --- | --- |
| Approved work / dependency change | Reconcile queue, check scope and quota |
| PR synchronize | Invalidate stale evidence; reevaluate |
| Review or check completion | Fresh metadata read; reevaluate exact head |
| Main integration completion | Verify acceptance and unblock dependent work |
| Manual reconcile | Authorized recovery and diagnostics |

This table is an intended design, not a list of implemented triggers. A trusted default-branch metadata-only adapter, durable deduplication, serialization and fresh API reads are prerequisites. GitHub token permissions, event propagation, supported dispatch APIs, quotas and protections must be verified before mutation. Never run untrusted PR code in a privileged job.

References: [reusing workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), [secure use](https://docs.github.com/en/actions/reference/security/secure-use), [GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token).
