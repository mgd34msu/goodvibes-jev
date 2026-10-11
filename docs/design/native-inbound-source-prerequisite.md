# Inbound original-source and held-delivery prerequisite

Scope: source preservation with injected offline validation. Live ingress requires
its own integration and authority boundary; source capture alone does not enable it.

## Construction boundary

`createNativeInboundSourceOwner` splits an ingress producer capability from a
read-only resolver. The producer captures the exact original text before trim,
command extraction or transcript enrichment, under its already-authorized
source-read/retention lifetime. Capture receives a lazy reader, so an absent or
revoked source permission fails before acquiring the content. Account and route
incarnations are construction-owned provenance. They never establish authorship
as the owner or permission to execute work.

The opaque in-process handle binds once to the actual broker's session/input
identity and immutable ingress facts. Broker body may be derived. It is neither
an original-text fallback nor a provenance test. Metadata, sender labels,
correlation IDs, a paired Agent credential and preview rows cannot mint a handle.
The immutable reference includes source ID/revision, canonical broker input ID,
session ID and a stable logical request ID. Forged or different references do
not inherit another input's proof.

Each capture requires the source's existing abortable lifetime. It must not
outlive that source's authorized retention. Explicit release retires an abandoned
capture; owner close, capture expiry and actual broker invalidation retire the
retained original. The construction's currentness check must fence account/route
replacement and source-read/retention revocation. This is an ephemeral registry,
not a new raw-content store or permission to extend existing retention.

## Agent handoff and independent authority

`createNativeInboundHandoff` is injectable and intentionally not installed in
Agent's production services. It takes only the canonical input identity from a
continuation request; task/body and caller metadata are ignored. The resolver
supplies the trusted source. A separate construction-owned processing owner
must fence a current scoped owner instruction/delegation, processing permission
and retention permission. Its authority callback receives provenance/reference,
not raw content. Its opaque revision must bind the entire owner, workspace, scoped
instruction/delegation and processing/retention permission incarnation; cached
acceptance cannot move to a different revision. Its lifetime signal must abort
on expiry, scope replacement or permission revocation. A missing capability leaves the input held.

The receiver is an explicitly injected owned receiver. The positive fixture is
synthetic; it is not the existing owner-text native capture API. That API does
not yet carry non-owner origin/delegation. Passing inbound text to it under the
Agent's paired credential would incorrectly promote provenance into owner
permission and is not implemented here.

Only the receiver's verified acceptance of the same five-field source reference
can produce `transferred`, or `started` with a real owned runner identity. Its
implementation must durably accept that exact logical request before returning.
An attempted call with a lost response stays unknown. Repeated dispatch polls
join/reuse the same request and never call accept again. Explicit status performs
read-only proof inspection; missing proof cannot create work. A cancellation
request is not an acceptance or completion receipt. Late responses after close,
source expiry or cancellation cannot convert to an accepted disposition.

## Broker disposition compatibility

Shared continuation results now distinguish held/unknown from transferred and
started. Wire dispatch does not consume or bind held/unknown inputs. Transferred
inputs are acknowledged without fabricating a local runner. Started inputs use
the existing runner/reply tracking path. A detached/replaced connection cannot
acknowledge a late continuation-runner acceptance. Legacy answer-reporting
behavior is unchanged. The bounded poll reads the broker's whole retained
500-input queue so a held newest tail does not hide older eligible inputs.

Legacy `{ agentId }` and `null` behavior is deliberately retained. In particular,
legacy null still means the caller elected the old consume-without-local-runner
behavior. Native callers must never use null for uncertain or held results.
Agent's existing body-only hosted promotion and local-spawn fallback are still
legacy and **not migrated**. Replacing that production runner now would hold all
current inbound continuations, because no live producer provides the required
source/delegation proof. This prerequisite does not silently change that behavior.
Owner composer capture and its existing native recovery are unchanged.

## Recovery and retention limits

The existing persisted broker row is the recovery anchor. Source and attempt
caches are not durable. Restart without the original ephemeral source proof
holds that same broker input; it does not reconstruct from broker body, recapture
it under fresh request IDs, or claim restartable positive native admission.
No exactly-once execution guarantee is claimed. A receiver that ignores abort
may still be running: the caller detaches as unknown, never as drained/completed.
The receiver must honor the source/owner fences before effects and must not keep
raw content beyond its independent authorized lifetime.

## Next integration dependency

A real producer must capture the original before Slack trim/Telegram task
extraction (or equivalent), bind it to the actual broker input it creates, and
supply its existing per-message retention lifetime. A host-owned current scoped
instruction/delegation and processing/retention policy must independently permit
the receiver to process that source with its non-owner provenance intact.
Preview/inbox-display permission and the broker's existing body retention do not
supply those grants. Integrating source construction itself can reuse an existing
authorized original/lifetime without a new raw store; enabling processing cannot
be inferred from that fact. Only after those dependencies and an appropriate
non-owner native receiver contract exist should production Agent cut over.
