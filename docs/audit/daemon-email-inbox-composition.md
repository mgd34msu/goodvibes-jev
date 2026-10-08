# Explicit account-owned email inbox

THE-18 remains **In Progress**. `createEmailDaemonInboxFactory` now composes one
explicit TLS mailbox on a single-node daemon. It is an opt-in launcher capability,
not a default all-provider `serve` implementation. Default serving still refuses
until the entire required composition is available. Cluster enrollment/failover,
other providers, triage and required live proof are not claimed here.

## Original source and canonical ownership

The pinned original is `goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
`src/daemon/handlers/inbox/providers/email.ts` and inbox registration. The adapter
now reuses EmailService, canonical IMAP parsing, the existing protected local
source owner, the existing 60-second intake poller, and the inbox SQLite mirror.
It does not restore the old lexical redactor, create another retry loop, read
credentials directly, mint sender authority or invent an account.

A trusted launcher supplies exact expected TLS host/port, username and mailbox,
plus the real protected local-service identity/retention authority. Canonical
configuration must already provide the mailbox endpoint/account and disable
clustering. The existing canonical reader derives mailbox readiness; no separate
email-enable switch is introduced. The root passes
a narrow `createEmailService` capability into explicit inbox controls. That
capability composes the existing `composeMailDeps` over actual config/secret
managers and owns its lifecycle subscriptions. It exposes a service and close,
not raw credentials or generic secret access. Ignoring the capability acquires
nothing. Constructor failure, surface startup failure and repeated close retire
all acquired mail lifetimes, including partial subscription failures.

Inbox and interactive mail use separate read-ticket owners over the same
canonical account/config/secret subscriptions. An inbox poll therefore cannot
steal an interactive reply-subject read ticket. Config and all secret changes
(including aliases and ABA) synchronously revoke each owner's observations.
The canonical IMAP TLS connector explicitly enforces certificate and hostname
verification even under a weakened ambient TLS environment; ordinary CA trust
continues to apply. Synthetic injected transports are constructor seams only.

## Complete source and protected disposition

The strict snapshot prerequisite is documented in
[daemon-email-inbox-prerequisite.md](daemon-email-inbox-prerequisite.md).
A content page reads every selected message completely before offering any row.
Screening receives full original headers, original BODYSTRUCTURE, all decoded
inline text sections, and deterministic subject/body display candidates. No
source is clipped to fit screening; the existing protected owner's capacity
limits can hold an oversized source. Display bounds (200/500 characters) are
applied only to settled protected projections, never to a raw fallback.

Each message's source observation is checked around capture, judgment,
projection, release and commit. Cancellation or account/service revocation
releases the source, aborts shared retries and drains admitted work. Existing
Jev screening and shared retry own all meaning judgments; the new adapter has no
lexical privacy/importance/sender-policy table. A held, malformed, unsupported,
missing or aborted source withholds the entire page and leaves its UIDs pending.
There is no metadata-only or empty-body success substitute.

The current adapter publishes only successfully protected messages. The shared
checkpoint contract can express canonical terminal suppression/gone outcomes,
but this adapter does not invent either disposition to skip a difficult source.
From is a claim used for a stable digest, never command authority. No route is
fabricated. Item IDs contain only the account-scope digest, UIDVALIDITY and UID.
`receivedAt` records local intake time for mirror ordering/retention; sender Date
never controls polling progress.

## Seed, progress and disclosure

`readInboxPage` first plans a history boundary using strict complete UID SEARCH,
without fetching bodies. If the mailbox fits the initial bounded page, history
starts at UID1; otherwise the first eligible UID is the minimum of the newest
page and the exact older-message count is recorded as excluded. The seed/reset
checkpoint has `lastTerminalUid:null`: excluded history is not labelled processed.
The poller durably commits this boundary alone before any content page. A failed
first message cannot cause a later newest-page retry to silently abandon it.

Nonempty seed/reset reports `pending`; content begins on the next normal
60-second cadence. A strict empty SEARCH can report empty after committing its
empty baseline. Later polls read the oldest pending UIDs in ascending bounded
pages, independent of Date. Backlogs larger than one page remain explicit and
continue on the existing cadence. Failed/incomplete content never advances the
terminal watermark. A UIDVALIDITY replacement creates a distinct reset plan;
its commit removes only that provider's old-generation rows.

The optional wire `mailboxHistory` names its UIDVALIDITY, first-seed kind,
lowerBoundUid and skippedOlderMessages. `mailboxProgress` names UIDVALIDITY and
pendingMessages observed at lastSyncAt; this is not a live provider total.
Interrupted/failed polling can leave the count unknown, rather than reusing it
as a fresh fact. The output remains partial for omitted older history, observed
backlog, unknown seeded progress or an actual provider error. A historical
omission is disclosed separately from an error and remains visible after
catch-up. Slack/Discord do not acquire these fields or change timestamp behavior.
Existing item TTL/count retention still applies; a complete initial history
boundary is not a promise to retain all mailbox history forever.

## Atomic persistence and read fencing

The store filename binds a versioned expected account tuple by full SHA-256.
A strict lifetime lock under the canonical workspace prevents duplicate
in-process or cross-process ownership. It is retained through shutdown and is
not released if storage retirement fails. This single-node factory refuses
cluster mode before its own mail constructor, credentials, sockets or storage.

IMAP rows and their terminal checkpoint are staged in a private SQLite clone.
The canonical store validates exact prior-checkpoint CAS, ascending UID coverage,
terminal dispositions and published-item identity. It writes the staged image,
then synchronously rechecks trusted currentness immediately before atomic rename
and memory adoption. Failed writes, failed rename, cancellation and revoked
fences leave both durable and live state unchanged. Concurrent ordinary provider
writes or retention changes cause a rebase rather than being overwritten. The
ordinary save path remains available to existing users of the shared store.

Every mirror request acquires a generation-bound read lease with fresh canonical
account authentication. It reauthenticates after projection and validates the
same original account revision/UIDVALIDITY against the actual durable checkpoint.
A reset that lands while the second check is held cannot release already-captured
old-generation rows. Stored rows are withheld until the observed generation is
committed. Shutdown fences new work, cancels provider/source processing, drains
polls/reads/transport, closes storage and then releases the lease.

## Verification and limits

Tests use synthetic in-memory mail streams, owned loopback screening services,
real temporary SQLite snapshots and the actual daemon's authenticated HTTP host.
Coverage includes seed/content/restart, multi-page progress, account/config/secret
ABA, held screening/commit/read checks, generation reset, duplicate owners,
constructor/subscription failures, SIGKILL before/after atomic rename, malformed
sources, TLS weakening and full cancellation/retirement. Final exact-tree test,
type/schema and independent-review results accompany the change report.

No real mailbox, provider credential, login, external send, account change,
release or deployment is used. Real local-service retention/identity, semantic
calibration and provider-account proof remain live prerequisites. This composition
does not establish whole-session IMAP memory bounds or all-provider/cluster parity.
