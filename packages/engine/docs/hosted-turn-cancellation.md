# Cancel one hosted turn without ending its session

## Review status and ownership boundary

The broader ownership implementation is local review work. PR #75 remains held
until source review and consumer agreement; the earlier published partial head
still demonstrated an async command-hook mutation after `TURN_CANCEL`. Retained
negative evidence is not replaced by a claim of full clearance from green CI.

The intended settlement boundary is **this turn's owned execution**, including
its provider calls, tools, hook runners and hook-owned Agent contracts. Hooks
configured `async: true` may run concurrently without blocking each individual
tool dispatch. The turn's terminal event must join their actual settlement and
owned cleanup, not merely the dispatcher response or an Agent's status record.
Cancellation closes new admissions and requests abort on active owned work.
An ignored abort or an unproven cleanup leaves settlement pending; a deadline
must not race away live work and manufacture `TURN_CANCEL`.

**Independent workflow-trigger actions are excluded.** These are separately
configured event-driven automations with their own trigger ID and background
action, not the turn's owned hook runners. They may continue and mutate files
after this turn's terminal event. This endpoint also cannot undo effects already
committed externally or prove a remote HTTP server stopped processing a request.
Do not render cancellation as a global “all side effects stopped” guarantee.

Command ownership covers the tracked process group, not sandbox containment or
deliberate session detachment. Valid descendants may finish after their shell
leader exits; cancellation or the hook deadline requests group shutdown and
cleanup is joined. The new owned command mode refuses Windows before spawning
with `OWNED_PROCESS_GROUP_UNSUPPORTED`: “Owned process-group cleanup is
unavailable on Windows; command was not started.” Unscoped behavior is unchanged;
Windows owned-command parity remains open. In-process TypeScript hooks are
cooperative: an abort-ignoring handler remains pending until it actually settles.

Custom Agent/contract adapters must supply truthful owned settlement capability
before an owned hook starts. Unsupported capability is refused before admission
with `OWNED_AGENT_EXECUTION_UNSUPPORTED`, also exposed in hook activity. A
status-only adapter cannot certify drainage.
Hook calls outside an explicit turn scope retain their existing behavior.

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
including rejection paths. Scoped async runners are concurrent but owned;
terminal settlement joins them. This does not wait on arbitrary event observers
or independently configured workflow-trigger actions.

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
for this turn's owned settlement (`TURN_CANCEL`, `TURN_COMPLETED`, or `TURN_ERROR`, and preflight
failure where applicable). Cancellation is cooperative: a provider or tool
that ignores its signal may remain in flight until it settles. HTTP acceptance
must never be rendered as proof that external side effects have stopped.

The session, its attachments, and future queued messages are preserved. A
new execution receives a fresh identity even when its prompt and transcript
position match a cancelled pre-admission attempt, so replaying an old cancel
cannot hit the new execution. Cancelling a queued input, cancelling one tool,
and killing a hosted session remain separate operations.
