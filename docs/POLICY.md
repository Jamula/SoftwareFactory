# Policy and evidence guide

The current pure evaluator validates versioned policy and normalized snapshots. Its fixed-shape output carries a state, reason and shadow indicator. See the code and replay fixtures for the actual version-1 field contract; do not infer extra supported fields from this guide. Inputs are assertions, not independently verified live evidence.

| Evidence family | Required intent |
| --- | --- |
| Identity | Explicit repository, base branch and exact head/base |
| Protection | Trusted required check producers, independent current-head review, resolved threads, security and coverage |
| Work scope | Approved risk, ownership of changed paths, dependencies and acceptance |
| Capacity | Verified provider capability, quota, concurrency and budget |
| Control | Enabled mode and kill switch; missing or malformed policy blocks |

All examples are fictional and disabled. The `policySource` assertion does not prove the source is trusted. The eventual adapter must verify the source from reviewed default-branch configuration and construct evidence from authoritative reads rather than PR text. Fail closed for any missing, contradictory, malformed or stale evidence. A shadow result is neither an approval nor authorization. See [architecture](ARCHITECTURE.md) and [threat model](THREAT-MODEL.md).
