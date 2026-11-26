# Read-only queue reconciliation evidence (#8)

`reconcileQueueSnapshot` is a pure normalizer for the second read after a queue request. Its input is already normalized metadata; the module performs no GitHub reads and has no transport or mutation capability.

It binds a queue entry to one SoftwareFactory pull request, exact head and base, target branch, and entry ID. It accepts only the documented merge-queue entry states and refuses queue jumping. A changed head or base, missing identity, malformed state, or unmergeable entry fails closed.

A successful result means only that the supplied snapshot showed the matching queue entry. It always sets `mergeEligible:false`, `liveMerge:false`, and `dependentWorkAllowed:false`. It is not an enqueue receipt, a merge receipt, or proof that the entry later merged. Re-read after the queue observation and healthy-main verification remain separate. Existing protected-squash simulation models serialized mock receipt recovery and main health; neither module enables live queue operations.

The synthetic tests cover exact identity binding, changed heads/bases, scope, stopped state, malformed metadata, queue states, and refusal to convert observation into authorization. A trusted read-only adapter and measured eligible-to-merge latency remain future work requiring the existing review, protection, and authorization gates.
