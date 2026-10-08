# TUI passive historical planning (THE-105)

## Retirement boundary

The October 7 correction is bounded to the TUI. Jev makes runtime decisions;
there is no replacement human question/answer loop. This change starts from
main `3c0e82b67bc7d5a5c15b49281d9f0378cd355001` (tree
`bd95120d81bc9c0265bb73cbc345988f275a0b86`) and does not depend on PR #186's
rejected native question foundation. No engine question API, schema, protocol,
runner or hosted-session lifecycle is added or changed.

`/project-plan history` now opens a saved-record viewer with exactly four read
capabilities: `status`, `getState`, `listDecisions`, and `getLanguage`.
Its only action is refresh. It cannot call evaluation, generate suggestions,
answer or approve a question, dismiss a record, or hand derived text to native
intake. Old action IDs are inert, not compatibility aliases to a mutation.

Saved questions, recommendations and answers are labeled as historical content.
Readiness and approval are the values saved with the record. Opening a record
with no question does not invent a missing-scope prompt. Goals, context, tasks,
decisions, language, artifact/link metadata and approval provenance remain
inspectable. Long informational rows can be traversed in a narrow terminal.
Closing/refreshing advances the read generation so delayed reads cannot repaint
closed history or replace a newer view.

## Explicit operations remain separate

- `/project-plan` and `/planning` still enter native work/recovery. New goals
  retain exact original owner input and use native conversation intake.
- Historical `answer` and `approve` commands remain explicit record-editing
  compatibility operations. Their existing atomic source-revision guard,
  current-record capture, numeric-selector semantics and saved metadata remain.
  Deterministic SDK normalization within an explicit write is unchanged. No
  returned next-question or readiness coaching is presented as a new interview.
- Historical approval is never native execution authority. Inspection does not
  import a record, promote a saved completion claim, or retry a pending request.
- Explicit import and native recovery use their existing boundaries. Imported
  `done` is an unverified historical claim. Replay retains original provenance.
- Escape closes history. Historical dismissal, native cancellation and native
  recovery are distinct explicit actions; none is inferred from closing a view.
- An unavailable native host/Jev path cannot fall back to a historical planner
  or an ordinary model turn. A lost acknowledgement retains original IDs and
  source across restart; history never creates a synthetic replacement source.

## Verification coverage

The changed modal and host-renderer tests cover saved/no-question records,
nonselectable questions and answers, absent answer/approval/dismiss keys, inert
stale callbacks, no generated prompt, narrow rendering and long-row scrolling.
Real SQLite tests cover exact persisted bytes and source metadata across open,
refresh, close/reopen and process-store restart for saved approval true/false.
They assert no Jev requests, evaluations, writes, commands or native dispatch.

Command tests retain explicit stale-revision rejection, numeric saved IDs,
current-record indexing and approval metadata. Both planning aliases preserve
Unicode and exact whitespace through lost-ack recovery while history/panel and
retired pseudo-subcommands leave the native journal unchanged. Existing native
intake/import/recovery tests cover replay, repeated submit, changed principal,
cancellation and unavailable infrastructure without legacy fallback.

The compiled product-boundary fixture uses the production compile driver,
command/key routes, modal renderer, paired loopback host and durable native
journal in separate processes. It covers history → native import inspection →
lost admission acknowledgement → restart/recovery, exact owner source, one
native dispatch and no redispatch after another restart. Its synthetic host
cannot establish live-provider behavior.

The `TUI host pairing (compiled terminal)` CI lane also runs
`planning-history.e2e.test.ts` against the exact verified native artifact, with
its supported tmux harness. That separate test starts the actual terminal,
inspects/refreshes saved history, opens native recovery, restarts the same
isolated home, and checks unchanged saved bytes/approval and no model request.
The terminal witness compares the complete planning-source set, full persisted
records and raw-row generation hashes at each checkpoint. Normal asynchronous
startup scheduling writes separate `knowledge_schedules` rows in the same
SQLite file, so whole-file equality across full application startup is not the
planning-record invariant. Negative fixture tests reject raw JSON changes,
approval edits, and added/deleted/moved planning records. The isolated modal
tests still require whole-file byte equality and zero write calls.

Local qualification: source, renderer, real-store and compiled product-boundary
proofs ran. Full terminal assertions did not run locally: official Debian tmux
was extracted and verified, but creating the owned UNIX socket was denied with
`Operation not permitted`, including the supported execution-approval retry.
Exact-final-head hosted terminal CI is required before merge. Neither synthetic
proofs nor terminal smoke establish live-provider qualification or complete
end-to-end autonomous product parity.
