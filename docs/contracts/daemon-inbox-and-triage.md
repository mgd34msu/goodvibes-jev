# Daemon inbox and triage ownership

The host-only intake package owns provider adapters, protected mirror reads, progress, scoring
receipts and explicit tag operations. The daemon composes those owners into the existing
authenticated `channels.inbox.list` descriptor. Local storage, a protected preview, a provider
credential, an evidence receipt and a semantic decision are different capabilities; none substitutes
for another.

Use the [runtime construction and production-intake
contract](daemon-runtime-ownership.md#production-intake-and-selected-transport) for root startup,
selected transport, canonical config/secret managers and deployment authority. Use the [routing
contract](daemon-inbox-routing.md) for persisted channel/profile bindings, and the [cluster
contract](daemon-remote-and-cluster.md#cluster-election-membership-and-admission-lifetime) for
election and membership ownership. Project accounting and historical source/run receipts belong to
[THE-18 / current
TA-18](https://linear.app/the-artificery/issue/TA-18/port-daemon-composition-and-remote-cluster-infrastructure).

## Construction and provider membership

`@goodvibes-jev/engine/sdk/platform/intake` is a Node/Bun host subpath with source, declarations and
built ESM; filesystem/sql.js owners must not leak into browser or runtime-neutral facades.
`AdapterContext` lends read-only `resolveRef`/`resolveConfigSecret` and logging, never
credential-write access. Adapter registry construction preserves factory ordering, replacement and
filtering without resolving credentials or polling. Cadence constants are 30, 60 and 120 seconds.

`registerInboxSurface` copies explicit adapter membership and connects the canonical descriptor to
the cursor store, poller and aggregator. The product supplies configured, unavailable or genuinely
absent members rather than an empty default. `createProductionDaemonInboxFactory` represents exactly
Slack, Discord and email; it selects real account source factories only for explicit trusted
constructor options. Absence is a revocable local configuration/credential-presence fact: no
polling, raw credential resolution, fabricated successful sync, cursor, account mirror or screened
projection. Quarantined or unsupported presence refuses admission. Each read rechecks absence and
its config/credential generation.

Implementation: [index.ts](../../packages/engine/sdk/src/platform/intake/index.ts#L1-L83),
[provider-adapter.ts](../../packages/engine/sdk/src/platform/intake/provider-adapter.ts#L1-L216),
[production-inbox-composition.ts](../../products/daemon/src/runtime/production-inbox-composition.ts#L9-L114).

The daemon CLI exports single-source Slack/email inbox factories, their source factories,
`createMultiOwnerDaemonInboxFactory` and the production factory/runtime. A trusted launcher passes a
factory as `runtime.inboxFactory`; the production runtime accepts explicit Slack, Discord and email
member options. Discord source constructors are exported by their internal runtime module, not
individually by the CLI barrel. Source factories acquire account owners without binding the catalog;
the composite binds the inbox descriptor once. Calling multiple standalone handler factories against
one catalog is not composition.

Every source keeps its account-scoped SQLite mirror, lifetime lock, read proof, polling and optional
election eligibility. Constructor capabilities are not obtained from message text, provider payload,
environment variables, CLI flags or persisted enable switches. Built-in factories create plain owned
sources unless a separate explicit capability is attached. They do not automatically score, tag or
authorize hosted preview transmission. Configured standalone activation requires independently
established accounts and protected local-service authority; a token or reachable endpoint cannot
create those grants.

Implementation:
[production-inbox-composition.ts](../../products/daemon/src/runtime/production-inbox-composition.ts#L9-L114),
[multiowner-inbox-composition.ts](../../products/daemon/src/runtime/multiowner-inbox-composition.ts#L1-L58),
[slack-inbox-composition.ts](../../products/daemon/src/runtime/slack-inbox-composition.ts#L31-L155).

## Protected source and preview boundary

The [protected-source owner](protected-source-screening.md) owns full local source capture, semantic
span proposal/verification, uncertainty memoization, shared transport retry, revocation and release.
Hosts must establish both local services' identity, no forwarding, ephemeral no-log retention,
authority identity/revision, synchronous currentness and cancellation. Loopback addresses or
declarative retention strings alone do not establish that authority.

Screen the complete raw source and deterministic normalized display candidates before clipping. The
Slack/Discord mapper descriptor-captures exact string fields, keeps provider identities local and
releases the original source on every outcome. A missing, malformed, rejected, held or cancelled
result withholds the whole poll/page, with no raw-text, regex-redaction, metadata-only or
empty-preview substitute. Shape validation of a mapper output cannot prove its privacy semantics.

Projection uses the first 16 hexadecimal SHA-256 characters of the sender identity, a subject of at
most 200 characters and a single-line plain-text body of at most 500; bounds must not split a
Unicode scalar. Read each returned mapper primitive once into immutable locals, validate required
strings before digest checks and project those same values. Discard extra fields. A digest is a
stable token, not an anonymization or sender-authority guarantee; sender claims never grant command
authority.

Canonical sensitive-span projections use `[redacted]`. Ordinary prose remains unchanged only after
settled verification. Credential/card material subject to the pre-judgment safety floor withholds
the complete source before either model endpoint; typed historical replacement labels must not
weaken that refusal. Missing Subject in a valid IMAP envelope becomes the parser's empty string and
may yield a protected empty preview; malformed missing required string input refuses. No
undefined-input coercion is introduced.

The [text-normalization contract](intake-text-normalization.md) separately owns deterministic digest
widths/stability/distinctness, MIME plain-part preference, HTML entities/tags and script/style
removal. Malformed Unicode scalar entities remain safe literal data. These structural helpers
neither sanitize private content nor authorize disclosure; the complete-source privacy owner remains
mandatory.

Implementation:
[protected-preview.ts](../../packages/engine/sdk/src/platform/intake/protected-preview.ts#L16-L66),
[text-normalization.ts](../../packages/engine/sdk/src/platform/intake/text-normalization.ts#L10-L93),
[owner.ts](../../packages/engine/sdk/src/platform/security/source-screening/owner.ts#L48-L77).

## Mirror persistence and polling lifetime

The generic `InboxCursorStore` retains `.goodvibes/tui/operator/inbox.sqlite`, stable IDs and
mutable feed fields; an update omitting a route ID preserves the existing one. Provider timestamp
watermarks accept only finite monotonic advancement and are never reaped. Feed retention is 30 days
and 5,000 items, with count-only sweep disclosure. Keyset ordering is newest `receivedAt` first with
stable ID ties, and provider/since filters remain explicit.

Track mutation and persisted revisions so an older flush cannot mark a newer mutation saved.
Initialization, recovery-sweep persistence and close share their actual completion. Close stops
admission immediately, waits for startup and accepted flush/sweep work, performs the final flush,
and closes the handle last. Startup closed midway must not arm a timer; fresh init after close
refuses. Failed initialization can retry while open, failed persistence remains dirty/retryable, and
observer failures cannot escape timer ownership. Generic whole-file coordination is process-local:
independent process snapshots remain last-writer-wins, so a single store owner is required. Account
compositions add the strict lifetime locks described below.

Implementation:
[provider-adapter.ts](../../packages/engine/sdk/src/platform/intake/provider-adapter.ts#L1-L216),
[cursor-store.ts](../../packages/engine/sdk/src/platform/intake/cursor-store.ts#L1-L151),
[cursor-store.ts](../../packages/engine/sdk/src/platform/intake/cursor-store.ts#L153-L277).

The poller requests a bounded item count at each adapter's cadence using its persisted `since`,
deduplicates/upserts rows and advances the watermark only for accepted results. Synchronous start
methods arm polling without an immediate fetch; manual polling is available before start. Rejecting
one adapter cannot take down other providers. Configuration comes only from explicit adapter
evidence: a throw before a result leaves it unknown, while persistence failure preserves already
received configuration evidence.

Each provider operation owns a promise, AbortController and generation. Coalesced callers await that
work; cursor reads occur inside its protected lifetime and settlement always releases ownership.
Stopped or old-generation results and queued callbacks cannot mutate state or report a newer
generation's completion. If persistence was already admitted, stop awaits it. Timestamp commits use
a staged transaction and synchronous account/source/poll-generation fence before publication.

`stopProvider(id)` is awaitable and must drain before handoff; a later explicit start can resume
that provider. `stop()` synchronously closes all admission, permanently rejects further manual/timer
polls and shares one non-rejecting completion. Shutdown must await it before closing the shared
store, which neither stop method owns. Cancellation is cooperative: an adapter that ignores its
signal remains awaited. Logger/timer cleanup failures cannot create an unhandled stop promise.

Implementation:
[cursor-store.ts](../../packages/engine/sdk/src/platform/intake/cursor-store.ts#L300-L399),
[poller.ts](../../packages/engine/sdk/src/platform/intake/poller.ts#L99-L201),
[poller.ts](../../packages/engine/sdk/src/platform/intake/poller.ts#L202-L324).

Await registration `ready` before exposing its graph. Ungated readiness includes storage
initialization and the initial seed; setup failure rejects instead of fabricating an empty feed. A
gated surface is readable after storage initialization and fetches only after polling ownership is
granted. Gates receive awaitable start/stop controls and may return an awaitable unregister
callback. Resume a returned provider generation before its fresh seed; interval ticks coalesce with
that seed. Explicit clustered source startup may await seed admission rather than content judgment,
while the default registrar still awaits seed completion.

Close synchronously stops admission, restores the canonical descriptor for reuse, aborts polling,
retires host gates in reverse order, drains accepted work and closes storage. Repeated/reentrant
close shares one promise; stale controls cannot restart polling, and old teardown cannot erase a
replacement. Attempt all cleanup and expose aggregate failures. Legacy unregister starts the same
close with fixed diagnostics. Refuse a gate that returns its own surface-close promise; arbitrary
asynchronous promise-cycle detection is not promised.

Implementation:
[registration.ts](../../packages/engine/sdk/src/platform/intake/registration.ts#L100-L209),
[registration.ts](../../packages/engine/sdk/src/platform/intake/registration.ts#L210-L292).

## Aggregation and multi-owner read fencing

`aggregateInbox` remains a local mirror query, never a provider fetch. Normalize bounded limits;
preserve provider/since filtering, filtered totals, newest-first ordering, stable ties, opaque page
positions and a separate freshness watermark. `nextCursor` is pagination, not synchronization.
`hasMore` and `truncated` agree. `lastSyncAt` denotes the last completed attempt, successful or not,
rather than a success-only timestamp.

Report every known/requested provider. Standby is pending; explicitly unconfigured providers stay
named. Unavailable providers with true or unknown configuration produce an error and partial
response. Previously cached history may survive an outage with that error/partial status, subject to
the account read guard; failure does not imply an empty historical mirror. Preserve the canonical
`GatewayVerbError` code/status refusal shape, including malformed-cursor `400 INVALID_ARGUMENT` and
authenticated product-boundary denial of anonymous reads.

Implementation:
[aggregator.ts](../../packages/engine/sdk/src/platform/intake/aggregator.ts#L134-L245),
[aggregator.ts](../../packages/engine/sdk/src/platform/intake/aggregator.ts#L247-L390).

A composite borrows the canonical aggregator over independent stores/pollers. Each participating
source supplies the global limit plus one; merge `receivedAt DESC, id ASC` using SQLite BINARY UTF-8
collation, then one global lookahead determines continuation even on full final pages.
Provider/since filters affect counts, page position does not, and the freshness watermark never
regresses below supplied `since`. Preserve unknown-provider filters, configured absence,
cached-outage rows, IMAP history and pending-progress semantics.

The existing cursor contains timestamp and item ID, not account identity; reject duplicate wire
provider IDs. Namespaces are nonempty without `:`, and every persisted row, including rows beyond
the page/lookahead, must belong to its source and start with `provider + ':'`. Validate in SQLite
and at the final fence; refuse malformed sources with a bounded namespace error instead of rewriting
IDs/timestamps. Legacy single-store reads retain their arbitrary-ID compatibility.

Admit each source read before the first await and hold every source storage lifetime through
projection. Capture leases, check before reading, copy detached wire values, await all asynchronous
validations and synchronously recheck every captured proof immediately before return. Any stale
proof refuses the entire mixed-account response. Concrete protected sources require that final
synchronous fence; legacy asynchronous-only single-source guards remain a distinct compatibility
seam. ABA configuration cannot revive an old proof.

Only the composite owns its catalog binding. A second live canonical binding refuses. Start binding
retirement and all source retirements before awaiting any; drain accepted reads/polls and election
gates, close stores, then release locks. Failed storage retirement retains ownership. Partial
acquisition or readiness failure closes all acquired sources. Closing one independent source cannot
unregister another source's handler.

Implementation:
[multiowner-inbox-composition.ts](../../products/daemon/src/runtime/multiowner-inbox-composition.ts#L1-L58),
[registration.ts](../../packages/engine/sdk/src/platform/intake/registration.ts#L210-L292),
[registration.ts](../../packages/engine/sdk/src/platform/intake/registration.ts#L295-L402).

## Slack account and transport

`createSlackDaemonInboxFactory` / `createSlackDaemonInboxSourceFactory` require immutable expected
workspace and user/bot identity plus the real protected screening capability. Canonical settings
must enable Slack and match the expected workspace; `surfaces.slack.botToken` comes from the
existing read-only resolver. Missing/blank or unsupported-prefix tokens are unconfigured; `xoxb-` /
`xoxp-` are only structural admission, never proof of acceptance. Lookup failure leaves
configuration unknown; later identity/transport/source uncertainty is unavailable.

Every poll resolves anew, authenticates through `auth.test`, requires both expected `team_id` and
`user_id`, uses one captured credential, and resolves it again after mapping. Credential change
withholds the entire poll/cursor. Same-account rotation retains the versioned
provider/workspace/user SHA-256 scope; swapping accounts requires a new owner and deliberate cursor
migration/reset. Configured enabled/workspace/cluster mode is rechecked around owned work, and the
root config/secret invalidation hook revokes retained identity. Read leases preserve their captured
generation.

The account file is `inbox-slack-<scope-digest>.sqlite` under the canonical workspace. Its strict
lifetime cross-process lock excludes duplicate in-process owners too, refuses timed or corrupt-lock
takeover, and remains held through shutdown or failed storage retirement. Validated local PID
reclamation requires proven ESRCH, not age or malformed metadata. Credentials never name storage.

Mirror reads check account authority before and after projection. A changed token must prove the
same expected identity before releasing stored rows. An unchanged previously verified token may read
protected history during transport/5xx outages; restart reestablishes identity. Authentication
denial or mismatch invalidates proof, including `auth.test` 401/403 headers before body retirement,
and an older mapping cannot restore it. Keep fingerprints process-local and use fixed
scope-unavailable diagnostics.

Implementation:
[slack-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/slack-owner.ts#L80-L239),
[slack-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/slack-owner.ts#L239-L285),
[slack-inbox-composition.ts](../../products/daemon/src/runtime/slack-inbox-composition.ts#L31-L155).

The owned Slack HTTP client uses the fixed `https://slack.com` origin with explicit TLS
verification, and only GET `auth.test`, `conversations.list(types=im)` and `conversations.history`
with closed header/query projections. The default total timeout is ten seconds, at most two minutes,
including queue admission and decoding; decoded responses are capped at 8 MiB. Reject redirects and
visible proxy configuration even with `NO_PROXY`; an owned client must not inherit stale native
proxy routing.

Serialize admission with per-method 429 cooldowns from Retry-After; invalid/missing delay
conservatively uses the ordinary 30-second cadence. Await decoding, body retirement, cancellation
and close. Constructor-only client seams support owned fixtures and cannot redirect production
through messages/settings. Close fences new work, aborts transport/source processing, drains
accepted credential reads and polls, retires the mirror and only then releases its lease. Logical
read refusal is not itself cleanup failure.

Implementation:
[slack-http.ts](../../packages/engine/sdk/src/platform/intake/providers/slack-http.ts#L7-L103),
[slack-http.ts](../../packages/engine/sdk/src/platform/intake/providers/slack-http.ts#L104-L266).

## Slack complete history window

The private adapter implements history polling through `auth.test`, `conversations.list(types=im)`
and `conversations.history`; importing or constructing it performs no credential/network work.
Require explicit HTTP and trusted mapper ports and never fall back to global fetch. Capture
`signal`, `limit` and `since` once inside the guarded operation; exception handling must not reread
hostile option/signal accessors. Await credential, HTTP, mapping, optional routing and even
asynchronous logging, checking cancellation before and after each.

Use strict Slack decimal timestamp grammar and component rounding, never permissive parseFloat or
invented epoch-zero IDs. Preserve `slack:<channel>:<ts>`, unread state, sender-digest-only
projection and whitelisted output. Classification precedence is own-message/nonempty reactions,
literal self mention, non-root thread timestamp, then DM; structured bot messages/bot IDs are
excluded. These protocol comparisons do not judge urgency, spam or message meaning.

Freeze the integer cutoff before asynchronous work and send the same exclusive `latest` on every
history request. Admit only rounded `receivedAt < cutoffMs`, excluding the whole open rounded
bucket. Follow empty/short pages when a cursor exists; absent/null/empty cursors terminate, while
repeats, `has_more` without continuation or `is_limited: true` refuse the complete scan. Any
failed/incomplete channel withholds all new rows so another cannot advance past missing history.
Closed stage diagnostics must not inspect or render hostile rejection values, provider text,
credentials or raw identifiers.

Bounds are 1–1,000 requested items, 50 list pages at 100 conversations each, 20 history pages per
conversation and 200 history pages globally at 50 messages each. Retain only the globally oldest
`limit + 1` distinct raw candidates. A cap-boundary response succeeds only with actual terminal
evidence. After complete scanning, omit an entire boundary timestamp group if the lookahead shares
it; if no complete oldest group fits, refuse. Return whole oldest groups so the poller's strict
watermark cannot skip older unseen rows or half a tie bucket.

This is bounded catch-up. Oversized timestamp groups require a larger admitted budget or separately
reviewed cursor design; cap-exceeding backlog must not silently advance. Host/provider clock
alignment, late-visible/backdated messages, access/scope changes and eventual consistency prevent
transactional or exactly-once history guarantees. Newly accessible history below a saved watermark
requires deliberate backfill. History does not establish complete thread replies, Events/RTM
delivery or later reactions/edits to old messages. Optional routing failure leaves an item unbound
with only a fixed warning.

Implementation:
[slack.ts](../../packages/engine/sdk/src/platform/intake/providers/slack.ts#L67-L159),
[slack.ts](../../packages/engine/sdk/src/platform/intake/providers/slack.ts#L160-L292).

## Discord account and intended channels

`createDiscordDaemonInboxFactory` / `createDiscordDaemonInboxSourceFactory` require an expected bot
user ID, real protected screening and a trusted immutable nonempty intended-channel scope with
revision, abort signal and synchronous authority proof. Canonical Discord must already be enabled.
The scope digest binds account, sorted membership/revision and local screening owner/revision;
neither credentials nor outbound `defaultChannelId` establish an inbox catalog. Root invalidation
subscribes before any source-acquisition await and fences configuration ABA, channel/privacy
revocation, account/credential changes and root closure.

Authenticate `/users/@me` as the expected bot and resolve every intended `/channels/{id}` as that
exact DM (type 1) or group DM (type 3) with no guild identity before history. Missing, replaced,
malformed or inaccessible channels withhold the poll. Payloads may prove observed facts but cannot
add membership, select screening destinations or mint local authority. Every mirror read
reauthenticates and rechecks the full intended scope, with a fresh synchronous
credential/account/catalog fence after asynchronous validation.

Canonical local credential snapshots bind alias, tier, incarnation and mutation generation, refusing
external/env provenance, pending replacements and same-byte reincarnation before post-success
callbacks. Known 401/403 denial immediately revokes read/commit proof; stale success cannot restore
it. Remote permission changes become observable on a subsequent check, not through an invented
instantaneous notification. The account file/lock and close lifecycle retain the same strict
ownership ordering as other configured sources.

The fixed-origin Discord HTTP owner allows only authenticated GET self, declared channel metadata
and bounded declared-channel history. Reject redirects, ambient proxies, undeclared paths/channels
and extra query fields; bound headers/decoded bytes, serialize requests, apply a conservative
owner-wide rate-limit cooldown and await cancellation drainage. The HTTP port also owns provider
client-identification requirements, including Discord's User-Agent requirement; fixed path/shape
checks alone do not establish live-provider compliance. The constructor-only client seam is for
trusted hosts/fixtures. Close synchronously fences and drains transport, local screening, accepted
reads, poller and storage before releasing account ownership.

Implementation:
[discord-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/discord-owner.ts#L16-L123),
[discord-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/discord-owner.ts#L125-L238),
[discord-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/discord-owner.ts#L240-L376).

The adapter catalog receives resolved self ID, exclusive horizon and abort signal, never bot
credentials. It must attest complete intended membership for that exact account/horizon and settle
its owned resources; `complete: true` alone is not evidence. Reject incomplete, malformed,
over-bound or account-mismatched catalogs; duplicate catalog channel IDs are scanned once. Adding
previously missing channels below a global watermark requires deliberate reconciliation/backfill and
account/channel-scoped cursor ownership.

The configured owner validates its explicitly supplied intended scope; it does not implement
exhaustive historical DM discovery. The provider contract must not invent GET `/users/@me/channels`,
treat a READY/recent-channel cache as historical completeness, or infer live bot access to group DMs
from an enum/fixture. Supported self, channel and history endpoints do not by themselves supply a
complete bot DM enumeration mechanism. Preserve that API-documentation inference as a scope limit,
not live-provider proof.

Implementation:
[discord-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/discord-owner.ts#L16-L123),
[discord-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/discord-owner.ts#L240-L376),
[discord.ts](../../packages/engine/sdk/src/platform/intake/providers/discord.ts#L9-L154).

## Discord complete history window

The Discord adapter uses API v10, `surfaces.discord.botToken` and 30-second cadence, resolving
credentials/self each poll. Missing/blank token is unconfigured; lookup failure is unknown;
downstream failure is configured/unavailable. Require awaited HTTP, complete intended catalog and
trusted mapper ports. Capture poll options once within the guarded operation, contain hostile
accessors/rejections and project immutable single-read mapped fields with fixed diagnostics.
Optional route resolution remains awaited best effort using sender digest only.

Accept only canonical positive unsigned-64 decimal snowflakes. ID-derived milliseconds determine
`receivedAt`, ordering, horizon and since checks; ignore disagreeing optional timestamp metadata
rather than mixing cursor clocks. The first `before` is the zero-low-bit snowflake at the captured
exclusive millisecond cutoff, excluding that bucket. Send only `before`, page by the raw numeric
minimum ID and require strictly decreasing cursors, every row below its requested cursor and
matching explicit channel binding. Bot-only pages still participate in progress evidence.

Preserve `discord:<channel>:<message>` and unread state. Missing author falls back to the channel
only for sender digest, never own-reaction classification. Skip `author.bot: true`; for eligible
rows classify own-message/nonempty reactions, structured self mention, truthy referenced message,
then DM. Null reference remains DM; malformed typed fields refuse. Emoji text or urgency/spam words
are not classifiers. This preserves message-snapshot classification, not reaction-event ingestion.

Bounds are 200 catalog rows, 20 history pages per distinct channel, 200 pages globally, 50 messages
per response, item budget 1–1,000, at most `limit + 1` retained distinct candidates and 40,000
characters per candidate body. Complete every channel within bounds; a terminal short/empty page or
reaching the since floor must establish completion, including the last cap page. Any failure
withholds all items. Select the globally oldest complete timestamp groups, dropping an entire
budget-boundary tie group and refusing when the oldest group cannot fit.

No initial cursor plus over-bound history remains unavailable; activation needs a deliberate
initial-history policy. Tie overflow needs a larger permitted budget or new cursor design. A matched
self ID does not bind an old persisted cursor to an account. Host clocks, eventual consistency,
deletions/access changes and late/backdated visibility do not form a transactional snapshot.
Old-message edits/reactions require a distinct event transport/cursor; no unlimited synchronization
or exhaustive historical DM claim follows from this adapter.

Implementation:
[discord.ts](../../packages/engine/sdk/src/platform/intake/providers/discord.ts#L9-L154),
[discord.ts](../../packages/engine/sdk/src/platform/intake/providers/discord.ts#L155-L274).

## Email complete-source reads

`createEmailDaemonInboxFactory` / `createEmailDaemonInboxSourceFactory` compose the canonical
EmailService, strict IMAP reader, protected source owner, 60-second poller and SQLite mirror for one
explicit TLS host/port, username and mailbox. The root lends a narrow `createEmailService`
capability over its config/secret managers, exposing service and close rather than credentials; an
unused capability acquires nothing. Constructor/startup/partial-subscription failure and repeated
close retire acquired lifetimes.

Read-only batch/page readiness validates IMAP endpoint/account/reference prerequisites without
inventing SMTP settings or a new inbox-enable switch. Explicit `email.enabled=false` remains
authoritative; ordinary mail status/list/message/send APIs retain their full validation. Inbox and
interactive mail have separate read-ticket owners over canonical config/all-secret subscriptions,
including alias and ABA invalidation. TLS always enforces certificate and hostname verification even
if ambient TLS is weakened; ordinary CA trust still applies and injected transports remain
constructor seams.

Implementation:
[email-inbox-composition.ts](../../products/daemon/src/runtime/email-inbox-composition.ts#L1-L138),
[owned-inbox-mail.ts](../../products/daemon/src/runtime/owned-inbox-mail.ts#L1-L113),
[email-service.ts](../../packages/engine/sdk/src/platform/email/email-service.ts#L767-L785).

Compatible `listInbox({signal})` is a display page with one newest-message best-effort preview, not
a complete screening source. `getInboxMailboxObservation(result)` uses exact-result identity to
retrieve immutable mailbox, positive uint32 UIDVALIDITY, account/observation revisions, revocation
signal and currentness outside serialized wire data. Copies/deserialization and display mutation
cannot create or alter this proof. It grants no permission to transmit or act, and does not confer
the separate exact-result reply-subject authority.

`readInboxBatch({limit,signal})` opens one fresh authenticated read-only connection under the
existing lifecycle owner. Strict complete UID SEARCH selects the newest 1–50 UIDs (default 10), with
total match count; every selected message requires exact-UID headers, original BODYSTRUCTURE and all
supported complete nonattachment plain/HTML sections. Freeze results and nested sources.
Missing/gone/unsupported/incomplete messages, invalid mailbox identity or source-budget overflow
withhold the whole batch with no ingest callback or observation. A truly empty mailbox may return a
complete empty snapshot with evidence. No attachment bytes are fetched, no timestamp `since` is
accepted and no checkpoint/backlog completion is implied.

The strict path reuses canonical FETCH/BODYSTRUCTURE parsing with explicit completeness checks.
Reject missing/duplicate/malformed UIDs or SEARCH, ambiguous/partial sections, omitted MIME leaves,
unsupported extensions/charsets, invalid transfer encoding, decoding replacement and size mismatch.
Fixed incomplete reasons cannot embed source text. Literal-valued BODYSTRUCTURE fields,
message/rfc822 bodies and unsupported multipart/charset forms remain refusal cases. Retain raw full
headers, original structure and every decoded section beside display fields; clipped/normalized
display text cannot substitute for source.

Refusal bounds are 64 KiB headers, 200,000 bytes of BODYSTRUCTURE, 200 leaves, nesting depth 24, 1
MiB source per message and 4 MiB per batch/page. Strict SEARCH/FETCH cap aggregate retained response
bytes, including unsolicited extras. Those source/strict-command caps are not a whole-session bound
for greeting, LOGIN, EXAMINE and LOGOUT. Never clip an oversize source into a purported complete
source.

Implementation:
[email-service.ts](../../packages/engine/sdk/src/platform/email/email-service.ts#L380-L410),
[email-service.ts](../../packages/engine/sdk/src/platform/email/email-service.ts#L456-L545),
[email-inbox-batch.ts](../../packages/engine/sdk/src/platform/email/email-inbox-batch.ts#L1-L53).

The canonical reply-subject source owner supplies observation lifetime. Account/config/credential
ABA, changed/invalid UIDVALIDITY and disposal revoke old observations. A completed same-generation
mailbox observation can survive a newer unchanged read; newer canonical reads cancel older pending
tickets. Compatible display completion cannot restore stale subject provenance. Bounded controller
eviction revokes evicted evidence. Publish and detach revoked state before synchronous abort
listeners so reentrant invalidation/replacement cannot erase a newer generation.

Pre-aborted reads perform no credential/socket work. An admitted secret lookup or connector is
awaited, and any late socket is destroyed before authentication. Abort closes the canonical session
during greeting, LOGIN, EXAMINE, SEARCH, FETCH or LOGOUT, awaits real socket closure and checks
currentness around callbacks/publication; no detached Promise.race is drainage. The production
connector retains its 15-second default connection timeout; it is not assumed interruptible before
returning and custom ports must eventually settle. Shared owners retain retry responsibility.

The email adapter screens full original headers, BODYSTRUCTURE, every decoded inline text section
and display candidates. Check message observations around capture, judgment, projection, release and
commit. Cancellation/revocation releases the source, aborts shared retries and drains work. Hold the
whole page and leave UIDs pending on any unsettled source. Only protected messages are published:
although the checkpoint schema supports terminal suppression/gone, this adapter cannot invent those
outcomes to skip difficult content. From is only a digest claim; IDs bind account-scope digest,
UIDVALIDITY and UID, while `receivedAt` is local intake time, never sender Date progress.

Implementation:
[reply-subject-source.ts](../../packages/engine/sdk/src/platform/email/reply-subject-source.ts#L18-L176),
[email-read-connection.ts](../../packages/engine/sdk/src/platform/email/email-read-connection.ts#L1-L52),
[email-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/email-owner.ts#L81-L225).

## Email UID progress and atomic publication

`readInboxPage` first plans a seed/reset using complete UID SEARCH without content FETCH. If the
mailbox fits the initial bounded page, use lower bound UID 1; otherwise use the minimum UID of the
newest page and record the exact omitted older-message count. Persist that history boundary alone
with `lastTerminalUid:null` before any content page, so failure on the first message cannot silently
reseed past it. Omitted history is not processed history.

A nonempty seed/reset reports pending; content starts on the next normal 60-second cadence. A strict
empty SEARCH may report empty after its baseline commits. Subsequent pages consume oldest pending
ascending UIDs independent of Date. Backlogs remain explicit across cadences and failure never
advances the terminal watermark. Changed UIDVALIDITY creates a separate reset whose commit removes
only that provider's old-generation rows.

Wire `mailboxHistory` carries UIDVALIDITY, seed kind, lowerBoundUid and skippedOlderMessages.
`mailboxProgress` carries that generation and pendingMessages observed at lastSyncAt, not a live
total. Interrupted/failed polling may make seeded progress unknown. Omitted older history, observed
backlog, unknown seeded progress and actual provider errors each keep the answer partial; historical
omission stays disclosed after catch-up and is distinct from error. Slack/Discord retain timestamp
behavior without these fields. TTL/count retention remains independent of the initial history
boundary.

Implementation:
[aggregator.ts](../../packages/engine/sdk/src/platform/intake/aggregator.ts#L247-L390),
[email-service.ts](../../packages/engine/sdk/src/platform/email/email-service.ts#L456-L545),
[email-inbox-page.ts](../../packages/engine/sdk/src/platform/email/email-inbox-page.ts#L1-L98).

The email file scope is the full SHA-256 of a versioned expected account tuple; its
canonical-workspace strict lifetime lock prevents duplicate process/account owners and survives
failed storage retirement. Stage rows and terminal checkpoint in a private SQLite clone. Validate
exact prior-checkpoint CAS, ascending UID coverage, terminal dispositions and published-item
identity, write the staged image, then synchronously check current account/source/poll proof
immediately before atomic rename and memory adoption. Failed write/rename, cancellation or
revocation leaves durable and live state unchanged. Rebase on concurrent ordinary-provider/retention
changes rather than overwriting them; preserve the ordinary save path.

Every mirror read takes a generation-bound lease with fresh canonical account authentication.
Reauthenticate after projection and compare the original account revision/UIDVALIDITY with the
actual durable checkpoint. A reset during the second check cannot release captured old-generation
rows, and an uncommitted observed generation withholds stored rows. Shutdown fences, cancels
processing, drains polls/reads/transport, closes storage and only then releases ownership.

Implementation:
[cursor-store.ts](../../packages/engine/sdk/src/platform/intake/cursor-store.ts#L300-L399),
[email-inbox-composition.ts](../../products/daemon/src/runtime/email-inbox-composition.ts#L1-L138),
[email-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/email-owner.ts#L226-L310).

## Account-eligible cluster integration

Use the canonical [cluster election and admission
owner](daemon-remote-and-cluster.md#cluster-election-membership-and-admission-lifetime), not a
second tally or distributed inbox database. Explicit account sources authenticate metadata-only
eligibility before enrolling via `gatePollingOwned`; clustered custom owners must supply that
capability, and canonical config/secret invalidation remains required. Email uses no-checkpoint
mailbox planning with no FETCH, screening or checkpoint mutation, so a cold node need not already
hold a UID checkpoint. Discord validates its bot and declared channel scope. No account
name/credential travels on the election wire.

Probe once on startup, then every 30 seconds after completion without overlap. Actual
account/credential/config/source invalidation withdraws eligibility and drains accepted polling plus
the exact retired gate before reentry. Email generation replacement revokes old proof. Transport
uncertainty preserves still-current proof, with no invented expiry timer; held semantic content must
not rotate election ownership to resample. Shutdown cancels scheduling, fences stale probe
completion and drains before releasing storage locks.

Cluster startup waits for store preparation and owned seed admission rather than blocking heartbeats
on content judgment; the seed still owns cancellation/drain. An owned drain failure refuses
withdrawal, permanently fences local reentry, retains storage ownership and withholds explicit
RESIGN, including removed siblings. Heartbeat expiry can nevertheless permit another node to take
over: this is not a distributed lease or global no-overlap promise, and local commit/read authority
remains independently fenced.

State is node-local. Returning nodes resume their own committed mirrors/watermarks; cold nodes use
bounded initialization with email omitted-history/backlog disclosure. Standby mirrors can be stale
and still require account/generation proof. Do not infer previous-holder cursor continuity, globally
identical feeds, gap-free cross-node history or exactly-once delivery. Never copy only a cursor or
concurrently share opened sql.js snapshots. Legacy single-node gate/owner seams retain their
existing compatibility behavior.

Implementation:
[email-owner.ts](../../packages/engine/sdk/src/platform/intake/providers/email-owner.ts#L226-L310),
[inbox-eligibility.ts](../../products/daemon/src/runtime/inbox-eligibility.ts#L15-L106).

## IMAP protocol framing and optional routing

The bounded host-only `Intake` IMAP reader remains distinct from the richer EmailService. It
preserves LOGIN, SELECT, UID SEARCH, UID FETCH with a 600-byte BODY.PEEK and LOGOUT, injectable
client/socket boundaries, 20-second default deadlines and a 4 MiB raw response cap. Connection
readiness has its own deadline and observes eager greeting/early close; late callbacks cannot reopen
a closed client. Commands cannot overlap, and timeout, transport failure or exceeded bounds close
the owned socket.

Quote LOGIN/SELECT values and reject control-byte command separators before writing. Diagnostics
expose only command/status, never LOGIN credentials, rejection prose or raw transport errors. Count
original socket octets before decoding. Frame syntax and literals before canonical FETCH parsing,
stop exactly at the genuine tagged completion and leave later unsolicited traffic separate. Literal
NIL, quotes, whitespace, empty values, embedded UID/FETCH/tagged text and multibyte or
invalid/incomplete UTF-8 remain payload; they cannot fabricate protocol. Decode RFC 2047 encoded
words from bytes in their declared charset. An unreadable FETCH refuses rather than pretending the
mailbox is empty.

Both the intake collector and canonical `ImapSession` preserve explicit byte/literal frames into the
shared FETCH parser. Compatibility display-string adapters are not permission to parse literal
content as protocol. Protocol decoding performs no judgment or privacy sanitization and raw
envelopes stay local. The [routing owner](daemon-inbox-routing.md) consumes only provider,
structured kind and sender digest; failure leaves the item unbound, and source/account lifetime is
rechecked after an awaited resolver.

Implementation:
[imap-client.ts](../../packages/engine/sdk/src/platform/intake/providers/imap-client.ts#L54-L177),
[imap-client.ts](../../packages/engine/sdk/src/platform/intake/providers/imap-client.ts#L201-L301),
[imap-response.ts](../../packages/engine/sdk/src/platform/intake/providers/imap-response.ts#L1-L61).

## Typed triage inputs and receipts

The host-only intake API exports `scoreInboxTriage`, `runInboxTriage`, `readTriageMetadataBatch`,
`enrichItemsWithTriage`, the battery/model, closed types, `SqliteTriageStore` and `labelToTag`.
`TriageInput` contains provider-scoped ID, surface, optional subject/snippet, conversation kind and
unread state; metadata/extra properties are inspected but are not semantic features. Hosts
deliberately map protected previews instead of pretending every adapter supplies complete semantic
messages.

Descriptor-capture and privacy-inspect the entire original batch before field selection, hashing,
logging or port access. Refuse proxies, accessors, functions, cycles, symbols, exotic prototypes and
sparse/decorated arrays without invoking caller code; inspect nonenumerable data too. Bounds are 100
unique items, 20,000 data nodes, 64 levels and one million string characters. Credentials/card
material beyond preview lengths still meets the canonical safety floor. Bounds refuse rather than
clipping input or manufacturing a label.

`engine.intake.inbox-triage` v1 pins `jev-1.13.0`, fixed spam/urgency questions, high/medium stakes
bands and an accuracy floor of 0.85. Every item's two questions share one explicit fan-out
`JudgmentPort.ask` call for the batch. No port/credential discovery, heuristic fallback or default
live transport is installed. Spam takes precedence when positive and at least urgency's probability;
otherwise positive urgency is priority, otherwise normal. Both readings must be `act`; historical
confirm/escalate readings produce held receipts without a label. Scores/signals round to two
decimals and name the second signal `urgency`. Canonical tags are `GoodVibes/Spam`,
`GoodVibes/Priority`, `GoodVibes/Normal`.

Missing ports, failed/malformed answers, wrong requested/returned model and cancellation produce
operational unavailable receipts, distinct from valid held readings. This retained triage receipt
vocabulary must not create a human approval loop or be confused with the [autonomous Jev decision
contract](../design/autonomous-jev-decisions.md). New semantic decisions use the native
act/revise/defer/reject contract and shared transport retry; never rename old evidence, promote
uncertainty to act, resample unchanged held inputs into permission or add a second retry owner.
Caller-supplied live/recording ports own their side effects even in dry-run. Original text, input
fingerprints and provider failures are not logged.

Implementation: [index.ts](../../packages/engine/sdk/src/platform/intake/index.ts#L1-L83),
[battery.ts](../../packages/engine/sdk/src/platform/intake/triage/battery.ts#L1-L24),
[scorer.ts](../../packages/engine/sdk/src/platform/intake/triage/scorer.ts#L6-L53).

A settled receipt binds exact semantic input SHA-256, battery/version/model and original readings to
independently re-derived label, score, tags and signals. Capture all evidence before field access;
recompute bands/conclusions, require exact closed shapes and deep immutability, and match by item ID
rather than insertion order. Changed input or wrong model/battery cannot inherit evidence. Strip
incoming triage projections before adding checked current evidence.

Persist latest attempt and last-settled evidence atomically. Held/unavailable attempts update latest
while retaining historical settled evidence; history is not a current label. Only identical
latest/settled receipts matching the current semantic binding project. Metadata collection performs
one batch store read, validating the complete SQLite image before filtering IDs; this favors
corruption detection over large-store query scalability.

`runInboxTriage` borrows an injected store without closing it, or owns/closes the working-directory
store; persistence without either is an error. `dryRun` does not construct, open, read, write or
close persistence, even through a store getter. Check cancellation before/after judgment and at
persistence admission/publication; an aborted run does not persist its unavailable attempt.

Implementation:
[evidence.ts](../../packages/engine/sdk/src/platform/intake/triage/evidence.ts#L69-L107),
[pipeline.ts](../../packages/engine/sdk/src/platform/intake/triage/pipeline.ts#L7-L55),
[types.ts](../../packages/engine/sdk/src/platform/intake/triage/types.ts#L13-L50).

The default triage database is `.goodvibes/tui/operator/inbox-triage.sqlite`. Reload the latest
image under a process-wide queue keyed by canonical working directory/store path so same-process
instances and aliases cannot overwrite newer snapshots. Validate a complete batch before touching
storage, transactionally update latest/settled columns, export a prepared image and atomically
rename an exclusive same-directory temp file. Readers/close do not write; close refuses new work,
drains admission and is idempotent.

Refuse corrupt images, incompatible schemas, inconsistent records and unexpected schema objects
without quarantine, repair or replacement. Refuse managed-path symlinks/nonregular files; exclusive
no-follow temp creation and one-time canonical working-directory resolution preserve path ownership.
The generic store's queue is process-local, not cross-process mutation locking or protection against
a hostile ancestor-directory race. Account-owned wrappers add the separate lifetime lock.

Implementation: [store.ts](../../packages/engine/sdk/src/platform/intake/triage/store.ts#L12-L99),
[store.ts](../../packages/engine/sdk/src/platform/intake/triage/store.ts#L101-L188),
[store.ts](../../packages/engine/sdk/src/platform/intake/triage/store.ts#L189-L291).

## Owned scoring and read enrichment

`createOwnedTriagedInboxSource` owns one provider/account and participates in composite
registration; `registerTriagedInbox` also binds the existing descriptor without changing unrelated
handlers or inventing gateway triage methods. The explicit `runInboxTriage(query, operation)`
selects from the admitted mirror rather than accepting substituted caller previews. Select at most
100 rows, refuse larger limits, report total/hasMore/nextCursor and serialize scoring per owner.
Further pages require explicit calls; polling/listing never automatically score or tag.

Constructor-only `InboxTriageAuthority` binds a destination-specific port, provider/account,
ephemeral-no-log retention, revocation signal and synchronous live proof. Its destination string is
descriptive, not a grant. Config/message/environment/ambient port/bootstrap cannot create authority.
Missing authority permits un-enriched local reads but refuses scoring with zero judgment calls;
revoked authority refuses whole reads/scores. The real account read lease is mandatory
independently.

Project exact protected wire values to ID, provider, subject/body preview and unread, mapping only
declared `dm` to `direct` and `thread` to `thread`. Mention/reaction does not prove conversation
kind; omitted kind becomes the core's `service` default. Never transmit sender, route, credentials
or adapter metadata. Check canonical privacy/size before judgment, authority at actual outbound
attempts, and combined operation/grant/owner cancellation. Immediately before SQLite rename,
synchronously recheck account/semantic proof and exact selected input equality so changed rows
cannot persist stale receipts; this owned store fence is not caller-injectable.

Registration enriches after aggregation but before asynchronous revalidation and the final all-owner
synchronous fence, holding every source lease. Hooks receive immutable detached rows only for their
provider and return overlays; copy only triageScore/triageLabel/triageTags without changing
identity, order, counts, cursor, status or original fields. Read pages up to 500 use chunks of 100.
Empty reads/dry-runs do not create a store; absent images supply no evidence. Optional
corrupt/incompatible storage yields a clean un-enriched page with fixed `Inbox triage metadata
unavailable`, never repair/content logging. Privacy/input refusal and authority revocation are not
swallowed as optional storage failures.

A versioned provider/account SHA-256 filename discriminator and strict cross-process lifetime lock
cover the owned mirror and triage database, alongside the SQLite process-local queue. Close
synchronously fences, aborts semantic work, starts source retirement, drains accepted source
reads/scoring/commits and closes storage before releasing ownership. Failed retirement retains the
lock; uncooperative accepted operations are not falsely reported drained.

Implementation:
[registration.ts](../../packages/engine/sdk/src/platform/intake/registration.ts#L295-L402),
[owned.ts](../../packages/engine/sdk/src/platform/intake/triage/owned.ts#L17-L145),
[owned.ts](../../packages/engine/sdk/src/platform/intake/triage/owned.ts#L147-L240).

## Explicit tagging and authentic admission

Slack, email and Discord source constructors optionally accept `triageTagging.onReady`; readiness
delivers a handle over the actual source/mirror lease, never an activation-time mutation. Capture
constructor methods/options before awaits. Unknown providers refuse before credential access.
Missing activation exposes no capability, resolves no tag credentials and performs no
admission/provider work. The root supplies its existing recorded judgment port and autonomous
PermissionManager, never a new manager, persisted switch or human fallback. Callback failure closes
resources, and onReady must synchronously receive ownership.

`createOwnedInboxTagging` selects the exact current provider row under its real account read lease.
Hash the full row/account revision and recheck it at asynchronous boundaries and the actual effect.
Goal/criteria come from the explicit operation owner. Only provider, opaque account/target
distinction, conversation kind, requested tags and immutable prepared effects enter mutation
judgment; previews, credential bytes, raw provider/forum/account identifiers and row digests stay
local. Fresh opaque references are one-operation bindings, not caller-resolvable targets or
exemptions from semantic-text privacy checks.

Each mutation creates a fresh ToolRegistry bound to the exact PermissionManager. Include actual
custom-meaning and normal preparation decision IDs in `admitAutonomous`; `executePrepared` consumes
the authentic recorded admission. At transport, require `assertCurrentToolExecution`, exact
serialized argument equality, current source/account/credential/config revision and cancellation.
Prepared effects are one-use; changed, reused or transplanted bindings refuse. Card-bearing semantic
goal/criteria still refuse, even when genuine Discord numeric IDs happen to have card-like digits.
No fabricated permission, historical owner reply or settled meaning alone can authorize execution.

Implementation:
[tagged-owned.ts](../../packages/engine/sdk/src/platform/intake/triage/tagged-owned.ts#L20-L110),
[tagged-inbox-composition.ts](../../products/daemon/src/runtime/tagged-inbox-composition.ts#L27-L111),
[autonomous-jev-decisions.md](../../docs/design/autonomous-jev-decisions.md#L9-L39).

Capture and resolve credentials before judgment with a synchronous live snapshot through actual
writes. Managed-local snapshots follow real precedence and goodvibes aliases,
tier/chain/value/policy and mutation-generation identity; reject cycles, dangling aliases,
external/env provenance and pending mutation, including same-byte replacement. The daemon applies
the same literal-envelope decoding as its asynchronous getter. Snapshot values remain inside
credential ownership.

Root config/secret observation starts before asynchronous source construction. Startup mutation,
account reassignment, config ABA, alias/tier changes, row replacement and root retirement fence
stale work. Slack/Discord use their exact canonical bot-token keys. Only email uses the canonical
shared-password-to-IMAP fallback, binding both the winning snapshot and preceding absent/empty
observations. Remote identity reassignment behind an unchanged credential requires provider
reauthentication to become observable.

Close publishes its promise before cancellation, immediately fences new tag operations and drains
accepted work before source retirement. A failed tagging retirement cannot release the source early.
Partial provider failure stops the batch; completed HTTP effects are not automatically replayed and
a value-free refusal cannot be reported as full success. Successful operations return completed
`Promise<void>`, not historical success/skipped DTOs.

Implementation:
[tagged-inbox-composition.ts](../../products/daemon/src/runtime/tagged-inbox-composition.ts#L27-L111),
[index.ts](../../packages/engine/sdk/src/platform/intake/triage/tagger/index.ts#L49-L126),
[index.ts](../../packages/engine/sdk/src/platform/intake/triage/tagger/index.ts#L127-L167).

## Custom tag meaning and provider effects

Capture complete raw tag arrays with descriptor-only/full judgment privacy inspection before
trimming, bounds, hashing, deduplication or provider/model calls. Admit one to 32 nonempty names of
at most 256 characters, then trim/deduplicate. Canonical names are exact constants. Noncanonical
Slack/Discord reactions require `engine.intake.triage-tag-meaning` v1, pinned `jev-1.13.0`, accuracy
floor 0.95 and high-stakes confidence, reading the complete label as spam, priority, normal or
unknown, including negation/ambiguity. No substring/regex semantic dispatch or fabricated production
reading is allowed.

Require a recorded port, validated requested/returned model and actual decision lineage.
Unknown/low-confidence holds the whole batch before mutation. Identical held-name digests cannot be
resampled during that account tagger's lifetime; the set is bounded without eviction (1,024 combined
held/pending slots), and concurrent identical interpretation refuses. Shared permission cancellation
owns the wait even if an injected model ignores its signal, while recorder/retention guards prevent
late publication. A declared accuracy floor and fixture labels are calibration requirements, not
observed model accuracy.

Canonical effects are Spam → IMAP `GoodVibes_Spam`, Slack `no_entry_sign`, Discord 🚫; Priority →
`GoodVibes_Priority`, `rotating_light`, 🚨; Normal → `GoodVibes_Normal`, `inbox_tray`, 📥. Email
arbitrary keyword spelling uses `[^A-Za-z0-9_]+` → `_` as deterministic protocol encoding and does
not ask a model to rename it.

Slack applies exact channel/timestamp `reactions.add` with private bearer credentials, treats
`already_reacted` as idempotent success and stops on hard HTTP/API failure. Discord's exact
constructor-owned custom forum mapping takes precedence: observe matching thread/parent type and
existing applied tags before choosing a forum-only path, disclose mapped effects and unmapped
no-ops, then reobserve and merge fresh tags without duplicates/unrelated-tag loss. Failed/malformed
reads never PATCH; exceeding five applied tags refuses. A forum-to-nonforum transition cannot
silently become a reaction. Verified nonforum preparation binds reaction-only fallback. Configured
DM intake exposes reactions, not forum-channel intake or inferred channel-write authority.

HTTP mutations refuse redirects and bound decoded provider JSON to 64 KiB with guarded request/body
awaits and value-free diagnostics. The guarded IMAP writer preserves quoted LOGIN/SELECT, pre-socket
control-byte/UID/keyword refusal, exact single UID STORE, tagged OK/NO/BAD handling,
BYE/socket/greeting/timeout distinction, matching SELECT UIDVALIDITY, revocation before every
command, response bounds, inactivity and whole-operation deadlines. Its composed default is three
transient-only attempts; the lower retry helper clamps overrides to five attempts and two-second
delays. The account-owned mutation accepts one UID, even though the lower protocol helper retains
numeric-sequence-set grammar. Unbounded retry overrides and automatic replay of completed
Slack/Discord writes are not supported.

Implementation:
[index.ts](../../packages/engine/sdk/src/platform/intake/triage/tagger/index.ts#L49-L126),
[index.ts](../../packages/engine/sdk/src/platform/intake/triage/tagger/index.ts#L127-L167),
[meaning.ts](../../packages/engine/sdk/src/platform/intake/triage/tagger/meaning.ts#L9-L83).

## Validation boundaries

Use the [canonical daemon focused-test
procedure](../../products/daemon/docs/testing-and-validation.md#local-commands) and repository-owned
runner with owned temporary roots and synthetic credentials/identities/content. Keep structural/unit
sources, real owner composition and authenticated product invocation separate: an empty fake adapter
map or engine-only proof cannot establish production membership. Runtime receipts and their
exact-input/provenance formats above are functional data, not project tracking.

Preserve regression cases for store revision/flush/init/close races, retention callbacks, concurrent
inserts, failed persistence retry; poller handoff/restart/generation isolation/ignored-signal
drainage; registration readiness/failed acquisition/reentrant close/descriptor reuse and independent
provider status. Cover multi-owner global paging/ties/lookahead, full-store namespace refusal,
filtered totals, outage history, absence, generation/credential revocation, partial acquisition
rollback and all-owner final fences.

Provider window tests must cover multi-page/cross-channel continuity, strict-watermark restart,
duplicates and tie buckets, bot-only pages, frozen horizon, every request cap and terminal boundary,
invalid/repeated cursors, malformed timestamps/IDs, account rotation, withheld mapper fields,
single-read getters, hostile proxy/error values, route/logging failure and cancellation at every
awaited port. Negative controls must detect newest-first early cutoff, omitted bucket selection, raw
diagnostics or removed cancellation fences. Preserve complete-source mapping cases for
email/phone/IP exact spans, ordinary prose, full-source-before-200/500 limits, card/token
pre-transport refusal and valid absent-subject versus malformed missing input.

Email validation must exercise complete/unsupported MIME and FETCH shapes, exact UID/section/byte
bounds, malformed SEARCH, immutable exact-result evidence, generation reset, reentrant revocation,
read-ticket separation, cancellation at each phase including held credential/connector/socket
cleanup, TLS weakening, seed/content/restart/backlog, held screening/commit/read fences, duplicate
owners and interruption before/after atomic rename. Keep the separate IMAP STORE protocol's original
quoting/injection, UID/flag, tagged/untagged, BYE/close, socket/greeting, inactivity/deadline and
bounded transient-retry duties; a FETCH suite cannot replace mutation protocol evidence.

Triage validation must preserve single fan-out and every receipt disposition, complete-input
privacy/hostile-object refusal, model/binding/immutable evidence checks, ID reordering,
historical-label suppression, write-free dry-run, atomic/reopen/alias/close behavior,
corruption/symlink refusal, read chunks and exact-input changes during admission/commit/enrichment.
Test missing/revoked authority and zero automatic scoring. Provider mutation fixtures must exercise
real root/source/credential/mirror/permission owners, no activation/no credential/no admission,
fresh authentic rejection, credential/config ABA and pending replacement, numeric provider identity
isolation, unchanged semantic card refusal, exact/custom effects and forum precedence, sticky held
capacity, noncooperative late model completion, partial failure and close drainage.

Authenticated product coverage must assert exact Discord/email/Slack membership for invocation and
HTTP, aggregate wire field types, hasMore/truncated equality, filtering, malformed-cursor 400 and
anonymous 401. Keep one canonical inbox descriptor, no invented triage descriptors, exact unrelated
handler identity/invocation, descriptor restoration, empty-wire equality and unscored-row
preservation. Use real account-owned SQLite and loopback/intercepted transports to exercise callable
scoring and constructor-opt-in tagging through the actual production graph. Consumer-vantage type
fixtures must preserve intake wire mappings, host-only exports and read-only credential context.

Synthetic/recorded responses establish bounded behavior, never actual provider access, model
accuracy, local-service identity/no-forwarding/retention or production semantic-transmission
authority. A deployed account needs those independently established capabilities and live
semantic/provider calibration. Explicit Discord scope cannot stand for exhaustive historical DM
discovery; fixed protected redaction/whole-source refusal is an intentional adaptation rather than
literal historical privacy-output equality. Protocol/strict-source bounds do not imply whole-session
memory bounds. Full combined API/type/runtime, emitted-package/native-platform and release
qualification remain separate from a focused source contract or test inventory.

Owned test cleanup follows the [canonical runtime cleanup
contract](daemon-runtime-ownership.md#owned-temporary-cleanup): register the runner-owned root
before spawn, drain child/process groups before deletion, retain evidence when quiescence is
unknown, and never obtain deletion authority from child-supplied paths. Validate registered
allocations are removed while unrelated siblings/outside-owner allocations survive. Historical
prefix sweeps, unknown-root adoption and child-manifest compatibility cannot be assumed from these
cleanup tests.
