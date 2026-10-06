# Agent native remote owner conversation

## Boundary

The interactive owner composer captures its original text before trimming,
model directives, file expansion or shell context. With hosted conversation
routing enabled, that source enters the same paired-daemon native intake used
by local native turns. It never enters `sessions.hosted.create` or body-only
`sessions.steer`. Attachments and derived context remain explicit unsupported
source references; neither can become owner authority through prompt text.

The existing inbound channel handoff remains a separate boundary. This change
does not qualify inbound messages, add semantic approval, migrate legacy IMAP
framing, or claim native evaluator acceptance.

## Durable admission and delivery

The Agent journal confirms the exact request ID, input ID, original text,
unsupported references and optional continuation session ID before capture.
The hosted-delivery marker is saved with those bytes so a later settings
change cannot replay the source locally. The selected credential's source, home
and full private pairing record are bound by an opaque in-memory identity. Explicit environment overrides retain
precedence; private pairings require their expected live principal. Metadata-only
replacement or removal cannot revive a prior observer. Native stream and mirror
requests use the same captured connection and recheck selection before persistence.

The first authoritative source reference is also durably bound before hosted
mutation. A changed revision,
principal, project or continuation identity is refused.

Native conversational delivery sends only project ID, input ID and source
revision through `workLedger.turn.status` and the server-defined
`workLedger.turn.startAgent`. It never serializes a native permit or a body.
The latter chooses the Agent settings namespace in the host; caller text and
metadata cannot choose it. The host's atomic dispatch claim retains this
surface, rejects cross-surface replay, and binds one original to one broker
input. Existing WebUI starts retain their existing namespace.

A recorded work result continues through native work execution. It does not
also launch a hosted conversation. A recorded conversational result never
acquires the local turn permit when its saved delivery is hosted.

## Continuation and order

A later input waits until the previous hosted original is authoritatively
completed or cancelled. The next capture carries only that verified session
ID. The daemon captures and revision-binds the actual transcript; the Agent's
screen and local mirror are not transcript authority. It preserves the exact
new text and does not reframe an assistant message as a user requirement.

The Agent mirrors the original user message before opening the event stream,
then renders only frames correlated to the host-returned broker identity.
The host retains native turn/tool envelopes before the first observer in its
existing in-memory 500-entry ring; first attachment still receives at most the
existing 20-frame catch-up window. Live and replay readers share the same event
identity. No persistent provider log or broader replay audience is introduced.
Replayed, unrelated and uncorrelated terminal events cannot finish this turn.
When history was evicted, authoritative completion and unavailable reply history
are reported separately; missing correlation never authorizes a replay.
Status can reopen observation without submitting again, and repeated status
within one observer does not duplicate the original or reply.

## Cancellation and recovery

Stop during intake interrupts local waiting and requests cancellation of the
retained original. Stop while observing uses the same request/input identity;
a stale observer cannot cancel a newer input. Cancellation acknowledgement is
separate from a terminal streamed outcome. Detaching, closing the shell or
changing host, credentials, canonical workspace or project only detaches
observation. It does not claim the remote turn stopped.

`/work intake-status` is read-only. `/work intake-retry` and `intake-resume`
recover the same saved original; only an authoritative `not-found` dispatch
lookup permits its same-identity start. Unknown, preparing, running and
recovery-required results never trigger a new source or a body-only fallback.
`/work intake-cancel` targets the saved original, including a tombstone before
hosted delivery. A missing stream or lost HTTP reply remains unconfirmed until
explicit inspection. No automatic retry generates fresh IDs or revisions.

Turning hosted routing off selects the existing local native permit path for
new inputs. Recovery always follows the retained delivery marker. A prior
local dispatch without a confirmed completion cannot be silently converted
into hosted delivery.

## Verification

Focused controller, durable-journal and loopback HTTP tests cover exact bytes,
restart, reply loss, CAS/persistence failures, scope/principal/project changes,
revision mismatch, targeted cancellation and unsupported context. Observer
tests cover correlation, original-before-reply order, stale selection and Stop
while admission is pending. The compiled `native-remote-owner.e2e.test.ts` uses
an owned real daemon, paired setup, isolated homes, synthetic Jev/model
responses and Bun's real PTY to exercise the actual interactive entrypoint.
