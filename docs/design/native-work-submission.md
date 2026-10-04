# Explicit native work submission

This supplies a complete-source data boundary before native execution. It does
not interpret unrestricted conversation, generate original acceptance criteria,
replace legacy outer starts, or execute submitted work automatically.

## Source and owner

`workLedger.submit` accepts only `requestId`, `inputId`, the expected aggregate
ledger revision, and explicit `goal`/ordered `criteria`. Strings retain their
exact whitespace, Unicode and duplicate ordering. Empty/whitespace-only roots,
more than 100 criteria, text over 20,000 UTF-16 units, and a serialized UTF-8
request over 256 KiB are refused, never shortened. Source/model/approval/actor,
project and session fields cannot be supplied in the request.

The selected daemon constructs the project, session, paired actor, source ID and
source content revision. Source IDs bind the actual project, paired principal
and stable input ID. The revision hashes the exact explicit goal and criteria.
The source metadata is provenance; it does not grant execution or verification.

Both submission and request lookup require live paired admin authority with
`read:work-ledger` and the separate `write:work-ledger` scope. Import or fleet
scopes do not substitute. Shared-token and user-session principals remain
unsupported. The real pairing and workspace owners fence publication; the core
also checks the host's live authorization callback at its final commit boundary.
No token, grant, registration or deployment setting is changed by this feature.

The existing daemon admin policy derives its live scopes from the method
catalog. Adding the dedicated scope can therefore change the current scope set
without writing a token. Existing native execution associations compare their
captured scope ceiling exactly and may become stale after this expansion. This
upgrade preserves that fence and the old bytes; it does not rewrite historical
authority to make a prior receipt executable.

## Atomic submission and recovery

One `submit_native` ledger transaction creates the work, its first claimed
attempt, source provenance, history event and actor/request receipt. It advances
the aggregate revision once. The actor comes from the authenticated paired
principal. A second request ID cannot create another work for that actor/input
identity. The same actor/request with the exact command replays the original
event, even after the expected revision is old. Changed source or request data
conflicts. Replays do not create a new attempt or start an executor.

`workLedger.submission.get` accepts only the original request ID and returns that
principal's immutable receipt or `not-found`. It is the first operation after a
lost acknowledgement. Retain the original IDs, source and expected revision;
lookup does not authorize silently replacing the command. A publication failure
returns indeterminate/unavailable rather than invented rollback or cancellation.
A definitive ledger conflict requires an explicitly new submission decision.

The receipt carries real work/attempt revisions and exact roots. An explicit
subsequent execution start uses the existing native execution client and its
separate fleet authority. The native host keeps the submitted source ID/content
revision and source bytes. Its recorded Jev admission, captured input authority,
cancellation, recovery and no-effect-replay boundaries still apply.

## Persistence migration

KnowledgeStore schema 5 uses ledger state/row format 2. Migration validates the
old state by replaying its signed commands and checking every history and receipt
image before adding `source: null` to historical work. Null means no new explicit
input provenance; no IDs or historical authority are synthesized. Existing
native execution and admission-intent JSON is retained byte-for-byte. Old schema
4 writers refuse the newer database.

New source-bearing work rejects the legacy revise operation. Its original source
is immutable; a future source-aware revision operation must define new source
provenance explicitly. Source-less historical work retains its existing record
editing behavior. Neither historical approval nor reported completion becomes
execution permission or verified evidence.

## Integration boundary

The daemon composes submission over the existing ledger owner and shares the
existing workspace scope owner with native execution. Submission never acquires
or invokes an execution graph. Clients capture complete explicit source once,
retain the immutable request through uncertainty, and render submission receipts
separately from execution receipts. Free-form extraction, ordinary conversational
routing, agent spawn entrypoints, hosted direct contract starts and legacy
planning replacement remain a later coordinated cutover.
