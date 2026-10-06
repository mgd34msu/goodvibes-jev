# Native hosted conversation delivery

A genuine `turn` admission from Work → New → Native request now continues
through `workLedger.turn.start/status/cancel`. One Submit captures the complete
original and asks Jev for its disposition; an admitted conversation is delivered
automatically. No browser semantic classifier, approval/Start gate, legacy chat,
contract or task fallback is introduced. The existing shared Jev transport owns
availability retry.

## Authority and identity

Every route requires the transport's current opaque paired-admin authority,
`read:work-ledger`, `write:work-ledger` and `write:sessions`. The server loads the
original source from its real intake owner, checks project/input/revision, and
pins the paired principal, authority revision and scope set across asynchronous
preparation. Neither wire fields nor serialized snapshots grant authority.

The request contains only project ID, original input ID and source revision.
The browser confirms its existing strict source journal before mutation and
rechecks the selected endpoint, native project, paired owner and client lifetime.
A separate browser dispatch journal is unnecessary: the host owns the durable
source-to-session/broker association before execution. Credentials, permits,
workspace selectors and source text cannot be supplied to the turn route.

After claiming delivery durably, the host obtains a genuine eligible terminal
admission result through the existing native intake client and binds its actual
process-local permit. It does not bind a copied result, status lookup or JSON
receipt. Terminal admission replay preserves the recorded decision and does not
rerun Jev. Revalidation reaches the actual source owner with the retained live
authority immediately before native execution.

The broker allocates its canonical input ID and correlation ID, retaining the
exact original text and complete admission source identity. This input is
reserved as delivered and never enters the ordinary hosted input retry/spawn
lane. The source's original session ID remains unchanged; the new hosted session
and broker input are separate identities. A same-text permit from another source
cannot substitute for that association.

## Dispatch and persistence

The host's bounded identity-only journal uses strict cross-process locking,
atomic publication, required file/directory durability and immutable transitions.
It retains up to 4096 records / 4 MiB without eviction. Corruption, conflicts,
capacity, lock failures and uncertain durability stop further dispatch. It holds
no credentials, semantic grants or serialized permits.

Only the operation that creates a fresh durable claim can dispatch. It records
`preparing`, then the exact hosted session and broker IDs as `dispatching` before
calling the real hosted runtime. A process restart with a nonterminal claim is
reported as recovery-required. Repeating start, opening the dialog and Inspect
cannot recreate its permit or repeat model/tool effects. Missing and unavailable
responses are distinct. A lost acknowledgement is reconciled by reading this
same identity.

The native runtime refuses queue acceptance and requires actual Orchestrator
completion. Its genuine permit preserves existing native restrictions on legacy
agent/workflow/contract launch. The hosted transcript is published with strict
durability before completion is recorded. Failed or ambiguous turns remain
recovery-required. Merely visible terminal bytes are not enough: terminal reads
confirm durability before reporting success.

Cancellation can win before dispatch and creates a terminal tombstone. During
preparation or execution it fences the exact process-local permit and waits for
that input's lifetime to drain. An in-flight local cancellation is shown as
`cancelling`; the terminal record is written only after actual drain. A different
or restarted host cannot prove another process stopped and returns
recovery-required without manufacturing terminal cancellation. Native completion
and cancellation do not join or abort unrelated queued ordinary turns. Cancellation does not undo effects already performed.
Closing the browser, changing selection or choosing New request only detaches
the local view. Reopening only reads. There is no automatic retry or unsafe
resume of an ambiguous dispatch.

## Proof and boundaries

Focused tests exercise competing processes, strict journal faults including
post-publication ambiguity, source/principal substitution, revoked authority,
forged permits, actual runtime completion, cancellation races and restart
reconciliation. Production HTTP proof uses the real paired daemon, intake
owner, broker, hosted floor and Orchestrator, with recorded Jev readings and an
owned loopback streaming model. Chromium replays the unchanged captured HTTP
bytes through the production WebUI and real IndexedDB.

These are orchestration and lifecycle proofs, not live-provider acceptance,
semantic calibration or independent settlement-security certification. Native-owned WebUI conversation composer continuation is described in
[Native session continuation](webui-native-session-continuation.md). Other ordinary
hosted create/steer/follow-up ingress remains a separate migration.
