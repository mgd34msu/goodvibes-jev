# Bounded paired native-work host

This implementation supplies the daemon native-floor factory over the existing durable runner. The daemon activates a separate graph lazily for authenticated existing-work commands; see [the native wire contract](native-work-execution-wire.md). Complete explicit sources can now be submitted through [native submission](native-work-submission.md) to create and claim work atomically. Submission never starts execution. Ordinary conversational intake remains separate. Startup alone never dispatches work, migrates an old approval into authority, or issues credentials.

## Supported owner and operation

The host implementation is isolated on the `@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution` subpath so ordinary ledger readers do not import the runner bridge. `createDaemonNativeWorkExecutionServices` composes the supplied native agent graph with both trusted owners. Its `execution` service starts an existing complete native `LedgerWork` with an active attempt claimed by the authenticated paired principal. The host, not wire input, selects the project root, project ID, session and original goal/ordered criteria. Stable work and criteria revisions come from that authoritative ledger; the criteria-set ID uses the existing engine helper.

Only a transport-created `nativeExecutionAuthority` qualifies. The transport resolves a real per-pairing credential, verifies the exact live and persisted pairing UUID, and retains the credential privately in a nonserialized capability. The UUID is the actual immutable authority incarnation. Decision bindings use canonical SHA-256 protocol encodings of that identity and the persisted workspace identity/generation; they do not invent new grant epochs. Raw identifier strings are kept out of semantic prose. Shared tokens, user sessions and legacy authenticators lack this supported identity and are refused. Current scopes are intersected with the transport's captured ceiling. The bridge requires existing `write:fleet` and `read:work-ledger` authority; it does not mint tokens or add grants.

All pairing writers reload under the same non-expiring owner lock, durably publish, then update memory. Native reads are strict and side-effect-free. Required publication confirms the file and complete canonical/alias directory ancestry; directory-sync failure is not silently accepted. A failed or ambiguous write fences native admission, preserves any already-visible post-rename bytes, and requires an explicit successful durable owner mutation to clear that live fence. Fresh native owners also confirm visible file durability before accepting authority. Interrupted ownership requires recovery rather than an age-based lock takeover. Ordinary atomic/JSON store callers keep their prior default behavior unless they opt into required durability.

## Prospective workspace identities

Workspace registry version 2 retains the existing coverage records and adds a random registry incarnation, a monotone scope generation, per-registration canonical directory incarnations and removal tombstones. New registration events can establish current scope identity. Existing version-1 registrations remain readable but native-ineligible; an idempotent add or provenance upgrade does not invent their history. Removing and registering again creates a new incarnation. A caller must intentionally establish a current registration; this patch does not perform that operation on a user's machine.

Native scope reads use the current primary file only, resolve actual canonical directories and pin the winning registration. Ordinary descendant coverage is supported. Linked-worktree-only coverage, missing/corrupt metadata and legacy fallback authority are refused. The legacy fold and Agent migration/backfill writers share the writer lock and refuse migrated stores rather than erase their history. Existing display/coverage semantics remain separate from native eligibility. The daemon checkpoint reader accepts both registry versions and still requires the original explicit checkpointEligible flag; native scope identity never creates a checkpoint grant.

## Durable association and launch

KnowledgeStore database schema 3 introduced `native_work_executions` alongside `work_ledgers`; schema 4 adds separate admission intents and cancellation tombstones, as described in [the intent contract](native-work-admission-intents.md). Ledger state and existing execution records remain version 1. Migration preserves existing work/history and creates no authority or execution record. Older database readers refuse schema 3. Current-schema table loss/corruption is not repaired into an empty authority; migration from schema 2 first validates its ledger table.

One execution record retains the complete source-bearing request, exact work/attempt target, captured scope ceiling, recorded Jev `act` and context, engine-owned receipt and native launch state. A work attempt cannot be rebound through a different criteria key. The bridge checks actual recorded successful call entries and matching decision/claim notes before launch; a copied structural receipt alone is insufficient.

The shared evaluator makes the start decision. A valid semantic refusal is distinct from unavailable transport or recording failure and creates no execution. No human confirmation loop or second transport retry loop is added.

Lock order is engine key ownership, paired authority ownership, workspace scope ownership, then the existing KnowledgeStore transaction. The transaction durably publishes the native association/launch claim before invoking the runner's synchronous live validator while ownership is still held. It releases ownership after invocation, not after the full executor lifetime. Observers never launch work. Existing PR56 input capture and original-owner read filtering are forwarded unchanged.

Exact start replay returns the same engine-owned IDs. Queued starts retain their association before acknowledgment and remain cancellable. Cancellation persists native cancellation, cancels the runner and joins its drainage. Host close fences admission and drains its runner work.

## Recovery boundary

`resumeAll` still does not launch native records. Explicit resume of an unclaimed prepared operation obtains a fresh recorded decision and current owner validation. An engine replay that reports a launch claim is retained as claimed even when the native acknowledgment was missing.

After losing the live owner, a `launch-claimed` record requires external-effect reconciliation and is refused by this bounded service. This implementation does not know whether arbitrary external effects ran, so it cannot authorize their replay. It supplies no pretend exactly-once delivery guarantee and no general effect reconciler. Terminal/replayed receipts remain inspectable through existing read paths.

## Remaining product work

The ordinary Agent/TUI and hosted-session intake and legacy `contracts.start/reply` still need coordinated migration. Native project discovery, the paired execution wire and the daemon foreground session-mode driver are now composed; Agent/TUI controls consume that wire in a separate change. The native factory requires its real PermissionManager, original read filter, recorded judgment port/log and native agent graph; installing its owners in a legacy intake graph alone would break that graph's source-less start paths.

Focused tests use actual paired and scope owners, the real KnowledgeStore transaction and real durable runner/AgentManager/orchestration with a scripted offline model. They cover source preservation, recorded admission, idempotent/concurrent delivery, revocation, criteria changes, queued cancellation, drainage, captured inputs, actual prepared-process restart, refusal of unreconciled replay, the v1-to-v2 checkpoint-coverage transition, and file/directory durability-failure boundaries. Persistence fixtures prove observed calls and failure handling; they do not simulate a real power loss. These are implementation regressions, not independent security clearance or authorization to publish or merge.
