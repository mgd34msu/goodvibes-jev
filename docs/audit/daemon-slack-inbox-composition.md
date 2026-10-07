# Explicit Slack inbox composition

This THE-18 increment supplies a working, content-bearing Slack inbox for one
explicit account on a single-node daemon. It composes the retained history
adapter, protected local source owner, canonical poller/store and authenticated
`channels.inbox.list` method. It does not finish default all-provider serving,
Discord/email composition, clustered ownership, native packaging or live proof.
THE-18 remains In Progress.

## Supported caller and prerequisites

`@goodvibes-jev/daemon/cli` exports `createSlackDaemonInboxFactory(options)`.
An embedding launcher passes its result as `runDaemonCli`'s
`runtime.inboxFactory`, retaining the existing host, signal and deadline owner.
The built `goodvibes-daemon` executable does not discover or invent these trusted
inputs. The constructor is also usable by the existing explicit runtime host.

The caller supplies a `SlackDaemonInboxOptions` value containing:

- `account.workspaceId` and `account.userId`: the expected Slack workspace and
  bot/user identity, established independently by the trusted composition root.
  Both are immutable for an owner lifetime; a replacement account needs a new
  owner. The expected user identity is not an undeclared configuration flag.
- `screening`: the actual `ProtectedSourceOwnerOptions` capability described in
  [the protected source contract](../contracts/protected-source-screening.md).
  The host must establish both local services' identity, no forwarding, ephemeral
  no-log retention, live authority/revision and cancellation. A loopback URL or
  a string declaring retention is insufficient evidence.
- Optional bounded `timeoutMs` for Slack HTTP. The default is ten seconds and
  the maximum is two minutes, including queue admission and response decoding.

Canonical configuration must already have `cluster.enabled=false`,
`surfaces.slack.enabled=true`, and `surfaces.slack.workspaceId` equal to the
explicit account. The existing daemon credential resolver supplies
`surfaces.slack.botToken`; no literal token is read from settings and no
credential is created or persisted here. A missing/unsupported token reports
unconfigured; transport, identity or source uncertainty reports unavailable.

The reusable engine export `createSlackInboxOwner` lives at
`@goodvibes-jev/engine/sdk/platform/intake`. Its constructor seam accepts a
trusted HTTP client factory for owned tests; the real HTTP owner still checks
its closed logical origin, methods, headers and bounds. These in-process
capabilities cannot be obtained from messages, CLI arguments or configuration.
The daemon factory likewise has constructor seams for ownership tests.

## Identity, durable state and reads

Every poll resolves the current credential, calls `auth.test`, and compares
both `team_id` and `user_id` with the expected identity before listing or reading
history. Slack documents these identity fields in
[auth.test](https://docs.slack.dev/reference/methods/auth.test/). Each poll uses
one captured credential and resolves it again after mapping; a change withholds
the entire poll, including cursor advancement. Same-account token rotation
retains the stable account discriminator and re-verifies the new credential.

The SQLite filename is `inbox-slack-<scope-digest>.sqlite` under the canonical
workspace's `.goodvibes/tui/operator` directory. The full SHA-256 digest binds
the versioned provider/workspace/user tuple, independently of credentials. A
strict cross-process lock on that file's owner path is held for the entire
store lifetime, including shutdown. This also excludes duplicate owners in one
process; strict ownership permits no timed/corrupt-lock takeover. Failed storage
retirement retains the lease. The existing lock may reclaim a validated local
PID only after proving ESRCH; it does not reclaim by age or malformed metadata.

Stored rows are guarded before and after each aggregate read. A changed token
must authenticate the same expected account before any previous row leaves the
mirror. An unchanged, previously verified token may read its redacted historical
mirror during a provider outage; a restart must establish identity again. The
receipt is invalidated by decoded authentication denial or identity mismatch;
an older in-flight mapping cannot restore proof after that invalidation. The
HTTP owner also invalidates on received `auth.test` 401/403 headers immediately,
so an overlapping read cannot use cached proof while body retirement is pending.
Transport failures and 5xx responses remain distinct from authentication denial.
The read guard returns only a fixed scope-unavailable diagnostic. Credential
fingerprints are process-local and do not appear in logs or stored rows.

Canonical configuration is rechecked around owned asynchronous work. Disabling
Slack, changing its workspace or enabling cluster mode withholds late work and
reads. Wire `provider` stays `slack`, stable item IDs retain the upstream
`slack:<conversation>:<timestamp>` form, and the ownership discriminator alone
is account-scoped. Profile IDs are not route IDs: no fabricated route binding
is added.

## Content, transport and lifetime

The owner always installs the protected mapper. It screens immutable complete
raw and normalized text through the local span proposer and typed Jev
verification before applying preview bounds. It preserves non-sensitive content
and the canonical sender digest. Unsettled or malformed mapping withholds the
whole poll; no metadata-only, empty-preview or raw-text fallback is installed.
Original source lifetime/release, uncertainty memoization and shared System One
retry remain owned by the existing protected source implementation. No original
message body is persisted by this composition.

The HTTP owner uses the pinned npm `undici/index.js` client at
`https://slack.com`, with explicit TLS verification. It only permits GET
`auth.test`, `conversations.list(types=im)` and `conversations.history` with
their closed query/header projections. It bounds decoded responses at 8 MiB,
does not follow redirects, and serializes admission through per-method 429
cooldowns using [Slack's Retry-After contract](https://docs.slack.dev/apis/web-api/rate-limits/).
Invalid/missing retry delays conservatively wait the normal 30-second cadence.
Visible proxy settings hold requests even with `NO_PROXY`; stale Bun native
proxy state cannot reroute this owned client. HTTP body retirement, cancellation
and close are awaited through the existing owned stream bridge.

The registrar retains its actual readiness, provider gate, polling generation,
cursor persistence and read-handler lifecycle. Close fences new work, aborts
owned transport/source processing, drains admitted credential reads and polls,
retires the mirror, then releases its lifetime lease. Logical refused reads do
not manufacture cleanup failures. No detached work is reported as settled.

This Slack factory refuses clustered composition before its own credentials,
sockets or disk writes; an embedding host can have acquired earlier runtime
services before invoking it. The
current cluster registrar cannot yet express account-verified enrollment and
withdrawal; enrolling an incapable node could prevent a capable node polling.
This composition makes no cross-node cursor replication or failover claim.

The adapter's original bounded complete scan, timestamp buckets and history
limitations remain documented in [the adapter audit](daemon-slack-inbox-adapter.md).
This is DM history polling; it does not establish events, complete thread
replies, old-message reaction updates or unlimited backlog recovery.

## Verification and remaining proof

All tests use synthetic credentials/identities/content and owned loopback
servers. Focused tests exercise fixed-route HTTP, stale native proxy state,
response limits, rate-limit queues, cancellation, account mismatch and rotation,
held mapping, duplicate leases, unchanged-token outages and read fencing.
The daemon integration exercises actual Slack HTTP → protected mapper → SQLite
→ authenticated HTTP, including restart/cursors, held gates, live configuration
changes and shutdown. Built package and full aggregate checks are recorded in
the PR alongside exact-tree independent review and CI.

No real Slack account, user message, credential setup or hosted private-text
transmission is used. Live service identity/retention, semantic calibration and
provider account proof remain THE-35 prerequisites, not inferred from synthetic
HTTP responses. Legacy IMAP and the separate native-settlement review are not
part of this increment.
