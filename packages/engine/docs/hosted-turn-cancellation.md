# Cancel one hosted turn without ending its session

## Known open async-hook ownership gap: draft remains held

This is a partial implementation update, not full cancellation settlement
clearance. Ordinary admitted file-hook dispatch is now awaited, including
rejection paths. Configured `async: true` hooks remain detached inside the
shared dispatcher, with no turn-linked running-handle registry or drain.
A real command-hook probe demonstrated a file mutation **after `TURN_CANCEL`**.
Agent consumers therefore cannot yet interpret that event as all admitted work
having stopped. The intended ownership/settlement requirement remains open;
[PR #75](https://github.com/mgd34msu/goodvibes-jev/pull/75) is held and must not
merge on the strength of ordinary-hook tests or green CI alone. This limitation
also applies to claims based solely on `HookDispatcher.fire()` resolving.

The repair preserves existing hook timeouts and explicit async configuration;
it does not silently disable async hooks or hide the unresolved behavior.

## Native request

Use the native operator method `sessions.turns.cancel` (REST `POST
/api/sessions/{sessionId}/turns/cancel`) with `{ "expectedTurnId": "..." }`.
The public typed client exposes `operator.sessions.turns.cancel({ sessionId,
expectedTurnId })`. Both identities are required. `expectedTurnId` is the
engine execution identity from `TURN_SUBMITTED`, not an input ID, a tool call
ID, a locally generated UI ID, or the shared session's active agent ID.

The route uses the existing authenticated operator route and `write:sessions`
policy. It resolves the session's bound runtime and compares the expected
identity synchronously before invoking that runtime's existing abort path.
There is no await between comparison and cancellation, no new runner, and no
cancellation signal retained for future turns. The immutable whole-turn signal
also gates every tool admission: before each serial call, after permission and
pre/post-hook waits, and after reentrant tool-event callbacks. Each admitted tool
receives the combined whole-turn and per-call signal. A cancelled turn cannot
open an un-aborted signal for a later tool; per-call cancellation alone still
allows other calls in the same turn. Admitted `Post:file:write/edit` and
`Fail:file:write/edit` dispatches are also awaited before terminal settlement,
including rejection paths. This retains the dispatcher's existing timeout and
explicit async-hook policy; it does not wait on arbitrary event observers.

## Responses

Every successful route response contains `sessionId`, `expectedTurnId`, and
`status`; `activeTurnId` is present when another or the requested turn is active.

- `cancellation-requested`: the matching live execution received the request.
  This includes repeated requests while it unwinds. It does not mean stopped.
- `already-ended`: this runtime remembers that exact execution ending. A newer
  execution is unaffected.
- `stale-turn`: a different execution is active and the requested ID is not in
  this runtime's recent ended history. Nothing was cancelled.
- `turn-not-found`: there is no active execution and the ID is unknown or has
  expired from recent ended history. Nothing was cancelled.

The ended history retains at most 128 identities in the current runtime. It is
not a durable audit log. Restart, runtime teardown, or eviction never turns an
unknown identity into successful cancellation. Missing local runtime IDs use
`404 SESSION_NOT_LOCAL`; an unbound or unsupported runtime uses
`404 LIVE_TURN_CONTROLS_UNAVAILABLE`; an absent/blank expected ID uses
`400 INVALID_ARGUMENT`. Ordinary operator policy refusals occur before the
handler is invoked.

## Settlement and UI behavior

Keep the UI in a cancelling/pending state after acceptance. The existing
runtime terminal event for the same `sessionId` and `turnId` is the authority
for settlement (`TURN_CANCEL`, `TURN_COMPLETED`, or `TURN_ERROR`, and preflight
failure where applicable). Cancellation is cooperative: a provider or tool
that ignores its signal may remain in flight until it settles. HTTP acceptance
must never be rendered as proof that external side effects have stopped.

The session, its attachments, and future queued messages are preserved. A
new execution receives a fresh identity even when its prompt and transcript
position match a cancelled pre-admission attempt, so replaying an old cancel
cannot hit the new execution. Cancelling a queued input, cancelling one tool,
and killing a hosted session remain separate operations.
