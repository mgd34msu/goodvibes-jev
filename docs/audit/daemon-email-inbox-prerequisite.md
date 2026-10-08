# Canonical email snapshot prerequisite

THE-18 remains **In Progress**. This increment prepares the missing email read
boundary; it does not install a daemon email inbox factory or enable default
`serve`.

The original adapter is
[`src/daemon/handlers/inbox/providers/email.ts`](https://github.com/mgd34msu/goodvibes-daemon/blob/443e5ee4d6cda0d36d57e2886398d0836074a4a9/src/daemon/handlers/inbox/providers/email.ts)
at the pinned daemon revision. Its legacy IMAP client, user-plus-UID item IDs,
lexical preview mapping and sender-date cursor cannot safely be copied into the
current account-owned, protected-source composition. The reusable EmailService
already owns current configuration, credential resolution and canonical IMAP
parsing. Its ordinary listing and message reads intentionally tolerate some
incomplete display data; they cannot stand in for complete screening sources.

## New bounded contracts

`EmailService.listInbox({ signal })` retains its compatible display shape,
including the one newest-message best-effort preview. It now supports
cancellation and captures caller options once. This is not a complete-body
source. `getInboxMailboxObservation(result)` retrieves immutable, exact-result
mailbox evidence outside the serialized wire shape: mailbox, positive uint32
UIDVALIDITY, an opaque account revision, an observation revision, revocation
signal and currentness check. Copies and deserialized results cannot retrieve
it. Mutation of an ordinary display result cannot mutate the observation.

`EmailService.readInboxBatch({ limit, signal })` is a distinct complete-source
snapshot. It requires the existing lifecycle owner, opens one fresh authenticated
read-only connection, validates a complete UID SEARCH answer, and reads the
newest 1–50 server-assigned UIDs (default 10). Every selected message must have
complete, exact-UID headers, BODYSTRUCTURE and every supported nonattachment
plain/HTML section. Results and nested source data are frozen. A gone message,
unsupported or incomplete source, invalid mailbox identity or exceeded source
budget withholds the entire batch. An incomplete batch emits no ingest callback
and receives no mailbox observation. A genuinely empty mailbox can yield a
complete empty snapshot with mailbox evidence.

The complete result includes the total SEARCH match count and only the bounded
newest page. It does not accept a `since` timestamp, advance a checkpoint, claim
unlimited backlog coverage or turn sender-authored Date headers into progress.
The raw full header block, original BODYSTRUCTURE and all complete decoded sections are retained beside
compatible display fields; the latter may still be clipped or normalized by
the existing display parser and must never substitute for the original source.
No attachment bytes are fetched.

The strict reader reuses the canonical FETCH and BODYSTRUCTURE parsers with
explicit completeness validation, leaving ordinary display reads compatible.
It rejects malformed/missing/duplicate UIDs and SEARCH responses, partial or
ambiguous sections, incomplete/oversized structures, omitted MIME leaves,
unsupported MIME extensions or charsets, invalid transfer encoding, decoding
replacement and size mismatches. Unsupported cases return a fixed incomplete
reason, without embedding source text in diagnostics. Literal-valued
BODYSTRUCTURE fields, message/rfc822 bodies and unfamiliar multipart/charset
forms remain explicitly unsupported in this first strict path.

Bounds are refusal boundaries, never truncation: 64 KiB headers, 200 KiB
BODYSTRUCTURE, 200 leaves, depth 24, 1 MiB complete source per message and 4 MiB
per batch. The strict commands also cap aggregate retained response bytes;
unsolicited extra responses cannot silently expand the proof. These bounds cover
strict SEARCH/FETCH, not the legacy greeting/LOGIN/EXAMINE/LOGOUT command paths;
this is not a whole-session transport memory-bound claim. Oversize messages
are not clipped into purported complete sources.

## Authority, cancellation and lifecycle

The existing `EmailReplySubjectSourceOwner`, already subscribed by
`composeMailDeps` to synchronous configuration and all secret-change events,
owns both observation families. Account/configuration/credential ABA changes,
invalid or changed UIDVALIDITY and disposal revoke old observations. Completed
mailbox observations survive a newer unchanged-generation read; pending
list/batch reads are cancelled when a newer canonical read takes the latest
read ticket. Existing compatible `readMessage` may finish displaying data, but
cannot restore obsolete subject provenance. Source/observation controllers are
bounded and eviction revokes the evicted receipt.

Revocation publishes and detaches all state before invoking synchronous abort
listeners. Reentrant invalidation, same-UID replacement or mailbox replacement
cannot overwrite a newer generation or erase its controller. The PR195 exact
canonical subject-result WeakMap and its original completeness checks remain
separate; neither a display envelope nor the new batch detail object acquires
reply-subject authority through this API.

Pre-aborted reads perform no credential or socket work. Cancellation during an
already-admitted secret lookup or connector call waits for that work to settle;
a late socket is destroyed before authentication. Once a socket exists, abort
immediately closes its canonical session, including waits for greeting, LOGIN,
EXAMINE, SEARCH, FETCH and LOGOUT. The operation awaits actual socket closure,
checks currentness around callbacks and publication, and never detaches work
with Promise.race. The existing production connectors retain their connection
timeout (15 seconds by default); this change does not claim to interrupt the
connector before it returns. Custom ports must provide their own eventual
settlement. No new retry loop is introduced.

Mailbox observations and complete bytes are evidence of a read, not permission
to transmit content or act on a message. A real adapter still needs independently
established expected account identity, fresh authorization, protected local
source screening for each complete message, and current source/route checks
through publication. This increment creates no account, credentials, source
service authority, judgment policy, send permission or live-proof claim.

## Remaining original composition

- Compose protected mapping over the complete raw headers and every text section,
  then derive bounded display previews only after settled screening.
- Supply exact account ownership and account-scoped durable storage/lease and
  read fencing; preserve cancellation/reload/shutdown at the composition root.
- Decide and prove the durable IMAP UIDVALIDITY/UID checkpoint contract. The
  generic intake poller's timestamp cursor cannot be populated from Date or
  treated as equivalent to server UID progress. A bounded snapshot must be
  explicitly labelled as such if used before a full progress bridge exists.
- Prove daemon authenticated inbox integration, ownership transfer and restart
  idempotency. Cluster enrollment, default all-provider serving and live
  service/account calibration remain separate gates.

## Verification

Only synthetic in-memory IMAP streams and existing owned loopback fixtures are
used. Tests cover complete and unsupported MIME/FETCH shapes, exact UID/section
and byte bounds, stable and replaced mailbox generations, immutable/exact-result
observations, malformed SEARCH, cancellation across every read phase, held
credential/connector/socket retirement, callback and abort reentrancy, and the
real daemon config/secret/disposal subscriptions. Existing PR195 subject-source
and compatible service/FETCH suites run unchanged. Focused source/test typecheck
and final local check results are recorded with the commit report. Full emitted
package/API baselines, repository aggregate checks and CI are not implied by
these focused checks.
