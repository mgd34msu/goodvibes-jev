# Explicit Telegram delegated intake and owner review

Status: source-integrated first stage of THE-105, not completed work execution.
No provider, credentials, live grant or live retention policy was changed in its
qualification. Nonselected Telegram routes keep their existing behavior.

## Real entry and owner commands

The daemon facade constructs `DelegatedTelegramIntake`, installs it in the shared
Telegram adapter used by webhook and polling, and registers these gateway methods
(and corresponding POST `/api/inbound/telegram/{operation}` bindings):

- `inbound.telegram.configure`: select one exact chat/thread for this host account.
  Requires `accountId` matching the configured bot username, `pendingRetention`
  equal to `memory-only-until-deadline`, an explicit positive `pendingRetentionMs`,
  explicit positive `configurationLifetimeMs`, and `onExpiry` equal to
  `release-original-and-hold`. There is no default memory grant. Configuration
  authority is process-local; only the deny-only route selection is persisted.
- `inbound.telegram.decide`: approve/deny one exact `approvalId` and five-field
  `ref`. Approval requires every choice in the generated command schema: purpose
  `accept-external-message-for-owner-review`, source retention mode
  `memory-only-until-review-close-or-deadline` and explicit milliseconds,
  `derivedRecord=external-source-reference-only-v1` and explicit retention
  milliseconds, `ownerMayReadOriginal=true`, and `execution=none`. Source lifetime
  must fit inside the configured owner lifetime; record lifetime must cover it.
- `list`, `status`, `read`: inspect owned pending inputs or accepted review records.
  `read` returns the exact in-memory original only while its original and owner
  fences remain current. Metadata remains readable after source loss; it reports
  `expired-or-lost` and `new-original-required`, never fabricates an original.
- `cancel`: cancel this review and retire its original. This is not an execution
  completion claim. `revoke` takes the configuration ID and retires every source
  owned by that configuration. Selection remains held, never legacy fallback.

These commands use the existing transport-created paired-token owner authority,
admin access and `read:work-ledger` plus `write:work-ledger`. Shared tokens, user
sessions, JSON authority objects, actor names, route allowlists and cross-channel
reply matching do not supply authority. A paired command is an explicit owner
operation; approval never originates from Telegram message text. Generic approval
surfaces can deny/cancel but their plain approve action cannot answer this ask;
the prompt identifies the exact dedicated decision command and required choices.

## Retention and provenance

Selection occurs before channel authorization, so raw selected text is omitted
from policy audits and generic proposal/approval reply matching. The host acquires
exact original text, including command, whitespace and CRLF, only under the
explicit current configuration window. Waiting on an invocation does not create
retention permission. The message invocation returns held after the broker ask is
raised; there is no provider-held approval connection.

The synchronous broker binder runs before publication or dispatch. Persisted
broker body is a fixed placeholder. Broker/approval metadata contains identity,
choice and provenance only. The original never enters owner-text native capture.
A persisted quarantine marker denies ordinary handover, runner claims, wire
polling/delivery and continuation after restart; it cannot mint source authority.

A per-message approval permits a concrete recoverable owner-review receiver. It
persists only the exact source reference, external origin, owner/workspace and
configuration revisions, approval/choice metadata, timestamps and review state.
The original remains ephemeral and abortable for the chosen window. The owner can
read and cancel through the dedicated commands. Expired persisted metadata is
removed while running or pruned on the next receiver startup; shutdown does not
promise deletion while the process is offline. Source-read fences are checked
before every use. The receiver never starts a provider, tool, contract or agent.

A durable matching receiver receipt means transferred/accepted-for-review, not
business work started. Broker input completion means that ownership transfer was
acknowledged, not that the external request was executed. Missing/stale/revoked
proof holds; lost acceptance is unknown and never retried under a new source.
Repeated calls use the same in-process provider message identity. Restart keeps
selected routes held without reconstructing from broker text or persisted receipt.
The receipt remains an honest record of acceptance when its original is gone.

## Remaining THE-105 work

This is the first usable delegated-intake stage. Linking reviewed external input
to a scoped non-owner native work proposal and actual execution still requires
its own explicit approved transformation/derived-record and execution contract.
Owner native capture, evaluator semantics, settlement, Slack provider composition
and public search are outside this change. No exactly-once execution claim is made.

## Offline qualification

Synthetic actual-adapter/gateway tests cover exact original preservation,
canonical binding and quarantine, explicit owner choices, generic authority
forgery refusal, approved owner read/cancel, expiry, account/owner/configuration
replacement, missing original on restart, and absence of raw source in persisted
JSON. Broker and exact-owner approval tests separately fence lost writes,
revocation races, direct handover/polling/claim bypass and remembered approval.

The process keeps at most 500 distinct provider-message deduplication entries;
after that it holds new messages without acquiring originals. Entries are not
evicted into a replayable state. This is a process-lifetime safety capacity, not
only the number of currently pending reviews.
