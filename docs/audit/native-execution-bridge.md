# Native execution bridge recovery checkpoint

This is an unfinished reconstruction after the executor loss on 2026-10-03.
The previous unpublished commits and test logs were lost. New validation below
applies to the recovered bytes only. The verifier was restored byte-for-byte:
its Git blob is 6747d0dd4bdefaa2e3b6b6ed05db488d95f82926, matching the retained
post-fix diff prefix 6747d0dd. Other files are functional reconstructions from
retained implementation context and public source, not asserted identical trees.

## Restored responsibilities

The existing project-scoped ledger row stores frozen work/criteria/attempt
identity, dispatch intent, shared Jev decision receipts, runner-issued identity,
and publication material. The journal validates full ledger history and receipts
before each operation. It does not mint runner IDs or implement an executor.
Host-only authority authenticates and revokes actors and atomically publishes the
normal report and evidence events with their ordinary durable receipts.
Current work, attempt, scope and authority facts fence dispatch and publication.
Only host composition receives these authorities; product readers see safe
status projections. Journal-only progress has a separate revision cursor.

The verifier calls the existing runner and contract criterion/quality batteries.
It captures a detached strict-schema-validated recursively frozen execution and
checks its canonical digest synchronously before runner access. Original goal,
ordered criteria and identity remain bound throughout asynchronous verification.
Recorded Jev checks, execution snapshots and contained host-read artifact hashes
support the attestation; model completion text does not establish verification.

The Agent and TUI display typed execution status independently of reported work
and verified evidence. No human approval/escalation control or local judgment
retry loop is added. Revise/defer/reject states are persisted, not treated as act.

## Integration still pending

Production dispatch remains disabled. The trusted daemon adapter must consume
the actual shared semantic evaluator and ContractRunner startDurable/resumeDurable
APIs once published. Raw JSON runner receipts currently provide a content-bound
storage seam; they are not the final runner admission contract. The shared
runner must own dispatch idempotency and unresolved effect recovery. The single
shared judgment boundary must own retry/backoff/cancellation. Existing runner
planning and correction must preserve the original goal and ordered criteria.

This checkpoint does not prove end-to-end restart/effect deduplication, wire a
new execution endpoint, or claim production completion. Independent review is
incomplete. The prior extended review was blocked; this recovery did not repeat
it. No live provider, user work, migration or deployment is exercised.

## Reconstructed verification

Ordinary synthetic tests cover SQLite outbox response loss/reopen, exact identity
replay, shared typed outcomes, actor revocation, changed authority generations,
stale work, atomic publication and replay, final cancellation, observer progress,
core-history validation, and owned shutdown. Real ContractRunner fixtures cover
correction and original criteria checks. A separate offline scripted provider
drives the real agent loop, receives the runner's correction nudge, and produces
recorded judgments reopened from a temporary SQLite fixture. Mutation-during-join
and malformed/digest-mismatch tests exercise the restored immutable-input fix.

The exact validation totals and commands are recorded in the recovery PR; older
checkpoint totals are not evidence for this reconstruction.
