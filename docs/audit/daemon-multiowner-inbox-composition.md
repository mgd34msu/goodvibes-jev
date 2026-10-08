# Canonical multi-owner inbox composition

This is an explicit in-process composition capability, not default all-provider
serving. The launcher must still supply trusted local protected-source authority,
verified account configuration, complete intended provider membership, and the
existing daemon runtime dependencies. There is no new CLI selection, shared
account database, credential discovery, or Discord production adapter.

## Public construction

The daemon CLI boundary exports:

- `createSlackDaemonInboxSourceFactory(options, factories?)`
- `createEmailDaemonInboxSourceFactory(options, factories?)`
- `createMultiOwnerDaemonInboxFactory(sourceFactories)`

For example, a trusted launcher can pass the following as `runtime.inboxFactory`:

```ts
createMultiOwnerDaemonInboxFactory([
  createSlackDaemonInboxSourceFactory({ account: slackAccount, screening: slackScreening }),
  createEmailDaemonInboxSourceFactory({ account: emailAccount, screening: emailScreening }),
]);
```

Each account retains its own owner, SQLite mirror, lifetime storage lock,
account-scoped cluster election, eligibility checks, polling and shutdown. The
composite acquires those explicit sources and binds `channels.inbox.list` once.
It never calls multiple standalone handler factories against the same catalog.
The existing `createSlackDaemonInboxFactory`, `createEmailDaemonInboxFactory`, and
engine `registerInboxSurface` single-source APIs remain available, including the
existing injected registrar seams.

## Query and cursor compatibility

The canonical engine aggregator remains the only wire projection. A narrow
structural read collaborator fans out to independently owned stores and pollers.
Every participating source returns the global page limit plus one; rows are
merged by `receivedAt DESC, id ASC`, matching SQLite BINARY UTF-8 collation. One
global lookahead establishes whether another page exists, including full final
pages. Provider and `since` filters apply to counts; page position does not.
The freshness watermark remains independent of page position and never regresses
below a supplied `since`. Statuses, unknown provider filters, configured absence,
outages with cached rows, IMAP generation history and pending progress retain the
original aggregator semantics.

The existing page cursor encodes timestamp and item ID, not account identity.
Therefore the first composition deliberately rejects duplicate wire provider IDs.
All persisted composite rows, including rows outside the current page, must use
`provider + ':'` as their item-ID prefix and belong to a provider owned by their
source. Provider namespaces are nonempty and cannot contain `:`. This is checked
in SQLite before projection and at the final read fence. Built-in Slack/email
owners already emit provider-prefixed IDs into account-scoped stores. Malformed sources fail
with a bounded namespace error; IDs and timestamps are never rewritten. Legacy
single-store reads retain their former arbitrary-ID behavior.

## Protected reads and retirement

Every included source admits a read before the first asynchronous step and holds
its storage lifetime until the whole projection has completed. The handler
captures all account leases, checks them before reading, copies detached wire
values, waits for every asynchronous revalidation to settle, then synchronously
checks every captured proof immediately before returning. A stale proof refuses
the entire response; there is no partially disclosed mixed-account page.

Concrete Slack leases capture credential identity epoch and lifetime. Concrete
email leases capture canonical account/mailbox observation, authority and identity
epochs, and committed UIDVALIDITY. Returning to an earlier configuration after
revocation does not revive an older proof. Protected composite sources require
this synchronous final fence; legacy asynchronous-only single-source guards remain
supported by the legacy wrapper.

A source never owns a catalog binding, so closing one cannot unregister another.
Composite shutdown starts binding and all source retirements before waiting for
any of them, aborts/drains accepted polls and reads, withdraws owned election gates,
and closes stores before releasing their lifetime locks. Failed storage retirement
retains its lock. Partial acquisition and readiness failures close all acquired
sources. A second canonical binding is refused rather than replacing a live one.

## Verification and remaining boundaries

Focused tests use real SQLite stores, pollers and aggregation with synthetic
accounts, loopback provider fixtures and MemoryClusterBus. They cover interleaved
paging/ties, namespace violations outside lookahead, filtering/counts, unavailable
membership, IMAP history, credential and generation revocation, read draining,
acquisition rollback, and account/election isolation. Existing single-source
registration and owner suites remain part of the regression set.

This does not establish a production Discord catalog or a live protected-source
capability bootstrap. Those remain explicit blockers to default all-provider
serving. No real accounts, credentials, provider installations, deployment or
lifecycle activation are part of this change.
