# THE-95 source-generation API

## Persisted-image correction after independent review

The original c70f79e implementation below passed its same-handle tests but was
**not safe across independently loaded sql.js handles**. Each handle retained a
private database image. Reading that handle and then saving it could overwrite a
newer owner's complete file, including unrelated tables. The unchanged public
peer probe reproduced both stale approval and duplicate absent-row creation. In
the recovered checkout, it and five additional cases produced 1 pass / 7 failures
/ 16 assertions before the correction, including two actual processes released
from a shared input barrier. The original proof is retained as historical evidence,
not acceptance of the multi-writer boundary.

KnowledgeStore now opts into coordinated SQLiteStore persistence unconditionally.
Caller configuration cannot disable it; unrelated SQLiteStore consumers retain
their existing default behavior. Every ordinary save and batch flush uses the
same canonical file ownership as a guarded source write. An ordinary save captures
its image at admission and refuses a changed persisted baseline rather than
overwriting another owner's work. Failed saves retain pending local data. This is
conflict detection, not an automatic SQL merge or retry policy.

The conditional operation reads a fresh persisted database image while holding
ownership. The complete source-generation check, row mutation and atomic file
replacement have no intervening await. Success adopts that image and refreshes all
KnowledgeStore mirrors before releasing ownership. After initialization, a source mismatch does not
publish any database bytes or run downstream task synchronization. Active batches
or other pending local changes produce `pending-local-changes` when the selected
source still matches; an already changed source retains `source-changed` priority.
Snapshot reads inspect current persisted bytes without replacing a dirty local
image. Refreshing mirrors does not rerun initialization retention.

When initialization itself prunes an over-cap history, it persists that change
through the coordinated baseline check before admitting caller mutations. A
conflict fails initialization and closes only its not-yet-ready internal image;
an explicit retry reloads the winning owner's file. The 501-settled-run regression
reproduced the previous indefinite first-action hold, and a controlled ordinary
writer during initialization verifies refusal, byte preservation and retry.
Ordinary saves also capture the local image epoch: a save queued behind a guarded
fresh-image adoption cannot republish the superseded image. Removing that check
reproduces the earlier persisted value in a real reopened database.

File publication writes and flushes a sibling temporary file before rename.
Directory and database symlinks, including relative/chained links to a not-yet-
created database, resolve to one canonical lock identity without replacing the
links. Cycles and missing target directories fail without file or lock creation.
Multiply
hardlinked databases are refused because independently replaceable aliases cannot
be coordinated by one pathname lock. This boundary coordinates participating
KnowledgeStore writers. It does not claim protection from an unrelated program
that ignores ownership and edits the database file directly, or distributed
ownership across hosts or OS process namespaces sharing a network filesystem.

Strict ownership must never evict a live holder by age, infer ownership from
malformed metadata, or fall back to publishing an empty lock. Its dedicated probes
reproduced 1 pass / 8 failures against the existing default lock, preserving the
existing successful real-dead-owner recovery case. The separate isolated candidate
now passes 114 tests / 1,111 assertions across strict ownership, the unchanged
default lock suite, persisted source races, ordinary and guarded process writers,
retention, symlink boundaries and planning compatibility. The final SDK, complete
engine test and public-consumer type projects pass with zero diagnostics. The
unchanged aggregate API check passes for 164 SDK subpaths / 10,037 exports and
3 terminal subpaths / 199 exports. Shared integration and publication remain held
for reconciliation; this isolated candidate has no full CI result.

The first type pass retained one fixture-only Buffer generic mismatch; the
annotation was corrected and the same projects rerun. The first API invocation
used a tools path without its bunx launcher, and the first subpath generation
preceded standard SDK asset preparation. Those failed setup logs remain separate
from the successful final aggregate command using the verified pinned launchers
and prepared SDK. Existing API Extractor warnings about its older bundled compiler,
Gaxios fetch and duplicate sql-js declarations remain visible. No gate was changed.

An accepted planning source write and its later derived task/work-plan writes
remain a multi-step operation. A stale rejection has no downstream effects; an
accepted source may persist before a later task-sync conflict or error. This
change does not claim whole-action all-or-none atomicity, and does not widen
operator authority or the trusted-admin compatibility described below.

The recovered source is based on public c70f79e. The ownerReply annotation is
restored from an exact hash-verified patch; its API entry will be regenerated from
this checkout. The former local 064935 commit and proof logs were unavailable
after the executor replacement. The public peer test is unchanged; the additional
five-case fixture was transcribed from retained tool evidence and rerun, rather
than represented as a recovered byte-identical file.

## Original generation contract and historical proof

Implementation workspace: goodvibes-quality-passport, branch dot/planning-revision-guards, initial base 1e78adcd859dbe37ff875a814f3cc533c252573f, normally updated to actual main cef1a3d529797d63ddb8e95f48904ec76c638dca before final proof. The PR51 planning-answer reader branch remains unchanged.

KnowledgeStore exposes getSourceSnapshot({id}|{canonicalUri}) and getSourceGeneration(id), synchronous after init. The snapshot is detached and reconstructed from the actual SQLite row. The SHA-256 generation covers sorted column names and every raw persisted value, including metadata JSON bytes. It is a full entity fingerprint, not a timestamp, mutable-cache identity, or write authority. Same-millisecond changes to any persisted field change this precondition; identical persisted entities have the same fingerprint.

upsertSourceIfCurrent(input, expectedGeneration: string|null) captures input before awaiting initialization. After init it reads the current SQLite row, compares the expected generation, and performs the source INSERT and cache update synchronously. A mismatch returns kind:'held', reason:'source-changed', current source and generation before any source mutation or save. A successful write returns kind:'written', the detached written source and its generation. Null means the source must be absent. No database schema change is needed.

ProjectPlanningStateResult adds optional revision:{sourceId,generation}. Current getState reads state and revision from one stored-row snapshot. Legacy readers can omit the field; a view-selected mutation must require a captured revision rather than falling back to current-mode.

ProjectPlanningService.applyStateAction receives project/knowledge-space/planning identity, an explicit expected value ({kind:'revision',revision} or {kind:'current'}), and a named action ({kind:'approve'} or {kind:'answer',questionId/questionIndex,answer}). It clones its input and freezes the expected binding before its first await. Current-mode captures the source once at its own admission and still enforces that generation at the final write. There is no automatic retarget/retry.

The result is discriminated by applied:true/false. Success includes the state, new revision, evaluation and optional answered question. A hold includes an explicit reason and the current state/revision. Task/work-plan synchronization only begins after a written source result, so a stale hold performs no downstream writes.

Only the named approve action sets executionApproved in this new operation. Metadata is not an approval command or a generation override. This does not replace existing authorization: the existing projectPlanning.state.upsert operator method and POST /api/projects/planning/state remain admin/write:knowledge operations and historically accept executionApproved:true as explicit trusted-admin input. Existing route tests assert that compatibility. The source fingerprint itself does not grant approval authority.

The TUI will pass its selected revision through command arguments into this actual API. Explicit manual commands capture current state through current-mode. No product mutex substitutes for the stored-row compare-and-write. The unchanged independent evaluation/duplicate-Enter probes and additional command/error/reopen admission tests already pass locally; final caller acceptance remains held until this shared owner and actual producer wiring are committed and composed.

Store and existing service/answer/route compatibility proof: 27 tests / 119 assertions; together with the merged planning-reader suite, 53 tests / 239 assertions using public knowledge exports and real SQLite, including byte-identical holds, reopened source/work-plan equality, same-millisecond mutations, mutable-cache poisoning, writers during init awaits, duplicate answers, caller-mutated expected bindings, and successful reopen. The SDK declaration pass on the initial base passed. Final current-main SDK and complete engine test-program types passed with no diagnostics. API extraction succeeded and subpath checks passed for 164 SDK subpaths / 10,037 exports and 3 terminal subpaths / 199 exports. The normal current-main commit hook checks credentials only; its success is not full integration proof. Existing API Extractor warnings about its bundled TypeScript version, Gaxios fetch and duplicate sql-js declarations remain visible in the log.

The trusted-admin compatibility finding is visible in sdk/src/platform/control-plane/method-catalog-knowledge.ts (projectPlanning.state.upsert, admin and write:knowledge), sdk/src/platform/daemon/http/project-planning-routes.ts (the admin POST handler), and test/project-planning-routes.test.ts (top-level executionApproved:true persists through the real route). No new HTTP route or permission grant is added.

The original generated API delta added the seven declared knowledge types, three store methods, the service action and the optional result revision. A later ownerReply annotation fixes an unrelated clean/incremental inferred-union ordering difference without changing behavior. The correction requires freshly generated API evidence.
