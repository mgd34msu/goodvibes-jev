# Private Slack inbox adapter (THE-112)

## Scope and source

- Issue: [THE-112](https://linear.app/the-artificery/issue/THE-112/hoist-private-slack-inbox-adapter), a THE-13 child related to THE-18.
- Initial target base: `mgd34msu/goodvibes-jev` `ffa8c715d0c10a6af3072561ba964647c03554e3`.
- Verified composed main: `df70645d7e5088736a0e7ea662b58e8ed121ce11` (PR89), incorporated by normal merge `139685a171a02fcb0ee081978fe203f07b754f4e`; the final delta from that main remains exactly the four paths in this slice.
- Pinned source: [`src/daemon/handlers/inbox/providers/slack.ts`](https://github.com/mgd34msu/goodvibes-daemon/blob/254699bf5d834cdca41436211ada1ae32bf89258/src/daemon/handlers/inbox/providers/slack.ts), commit `254699bf5d834cdca41436211ada1ae32bf89258`, Git blob `644a8dfe7f4f9f5f90af671498bc8a58292547f8`.
- Target: `packages/engine/sdk/src/platform/intake/providers/slack.ts`; offline behavioral fixtures: `packages/engine/test/intake-slack-adapter.test.ts`.

This is a private engine prerequisite, not finished daemon provider composition. It implements the existing `InboundProviderAdapter` contract and runs through the real `InboundPoller`, `InboxCursorStore` and aggregate reader in tests. It adds no public barrel/manifest exports, no default provider registration, no global-fetch fallback and no production caller. Merely importing or constructing it performs no credential or network operation. There were no live Slack calls, account reads or transmissions.

The source's supported request/response transport remains `auth.test`, `conversations.list(types=im)`, and `conversations.history`. This is history polling, not Slack Events/RTM ingestion. No claims of live credential, server, rate-limit, full thread-reply or reaction-change coverage are made.

## Required host ports and unfinished prerequisites

The host must explicitly supply:

1. The existing read-only intake credential store. Each poll resolves `surfaces.slack.botToken` anew; no credential or self-user cache masks rotation.
2. An HTTP port that resolves only after decoding the response and cleaning up its resources. The host owns request deadlines, response-byte bounds, cancellation and any service-specific rate-limit handling. The adapter passes the same abort signal and awaits the complete operation. A port that ignores cancellation and never settles still prevents shutdown from completing; there is no dishonest detached race that declares the work drained.
3. A trusted item mapper returning `fromDigest`, `subjectPreview` and `bodyPreview`. The mapper must implement the existing `InboundChannelItem` privacy/admission contract, including canonical 16-hex sender digest and display previews. It receives raw sender/text locally. The adapter snapshots each mapper field exactly once into immutable primitive locals, then checks type/shape/length and projects those same values. Numeric, array and coercible-object digests are rejected before regex evaluation. These checks cannot establish semantic privacy correctness. Missing, null, malformed, throwing or rejected mapping withholds the entire result and leaves the persisted cursor unchanged. There is no raw-text or normalization fallback.

Actual preview privacy mapping is still unfinished and visible. This change neither duplicates the pending THE-111 normalization/digest helpers nor imports them from an unpublished branch. It does not change THE-109, THE-111, the issuer-credential predicate, ledger import, product migration, PR56/execution admission or THE-49 legacy IMAP.

Only whitelisted fields cross the item boundary. Extra mapper fields are discarded. The sender appears in the item/route lookup only as `fromDigest`; raw provider user IDs never fill a public sender slot. Stable IDs retain the pinned `slack:<channel.id>:<ts>` spelling, including its conversation identifier, so existing mirror rows keep their dedup identity. No digest-based ID migration is introduced.

## Source accounting and repairs

| Pinned behavior | Target disposition |
| --- | --- |
| Provider identity, 30-second cadence and credential key | Retained. Missing/blank or unsupported-prefix token is explicitly unconfigured; a store error leaves configuration unknown. |
| `xoxb-` / `xoxp-` prefix tests | Retained as structural admission, not proof that a credential is accepted. Actual API refusal is configured/unavailable. |
| Self-message plus nonempty reactions, then literal `<@SELF>` mention, then non-root thread timestamp, else DM | Retained in this precedence order. These are Slack protocol/user-ID comparisons, not semantic text readings. Other users' reactions remain normal messages; own messages without reactions retain source behavior. |
| Structured `bot_message` or `bot_id` exclusion | Retained. |
| `since`, message timestamp conversion, stable ID, unread state | Retained with strict timestamp grammar and decimal-component rounding replacing permissive `parseFloat`. Missing/malformed timestamps fail the scan rather than invent epoch-zero IDs. |
| Best-effort self lookup | Repaired: unknown self identity makes the poll unavailable instead of silently changing mention/reaction classification. |
| List/history pagination | Retained and strengthened: follow empty/short pages with a cursor, accept empty/null/absent terminal cursors, reject repeats and `has_more` without continuation. `is_limited: true` is known incomplete history and fails closed. |
| Per-channel history failures skipped while other items advance the global cursor | Repaired: any incomplete scan returns configured/unavailable with no items. Existing mirror rows survive and aggregation reports a partial answer. |
| Stop after first newest-first item-budget batch | Repaired: scan completely within the bounds, retain only the globally oldest `limit + 1` distinct candidates, and return the oldest complete timestamp groups. The old behavior could advance the global cursor beyond older unseen messages and channels. |
| No fixed scan horizon | Repaired: capture integer `cutoffMs` before all asynchronous work, send a fixed exclusive `latest` on every history request, and admit only rounded `receivedAt < cutoffMs`. Excluding the whole open rounded bucket prevents cross-channel arrivals and half-consumed millisecond ties from being skipped. |
| Optional route resolution | Retained as best-effort, with only a fixed diagnostic on failure. The existing route helper is not reused because it renders resolver exceptions. |
| Error summaries/provider error fields and raw channel diagnostics | Replaced with closed stage diagnostics. Tokens, message text, raw API bodies, raw error strings and raw user/channel identifiers never appear in adapter errors/logs. |
| Asynchronous ownership/cancellation | Repaired: every credential, HTTP, mapper, route and optional asynchronous logger operation stays awaited; abort is checked before/after owned work. Late results cause unavailable or are suppressed by the poller's existing generation guard. |
| Direct mapping helpers/default registration | Not ported here: explicit required host mapper and private factory preserve the unfinished composition boundary. |

## Bounds and cursor argument

A poll accepts a positive integer item budget up to 1,000. It can inspect at most 50 conversation-list pages (100 conversations/page), 20 history pages per conversation, and **200 history pages globally** (50 messages/page). At most `limit + 1` raw candidates are retained, not the entire inbox. Repeated cursors cannot consume unbounded time. Reaching a page bound succeeds only when the final response actually exhausts that collection. Otherwise no items/cursor are committed.

The existing poller exposes only a strict millisecond `since` watermark and advances to the maximum returned timestamp. The adapter therefore cannot safely return a newest-first partial batch. After a complete scan, the oldest `limit + 1` distinct candidates suffice to determine whether an omitted row shares the budget boundary's timestamp. If so the entire boundary timestamp group is excluded. If no complete oldest group fits, the poll is explicitly unavailable. A later poll repeats the scan above the committed watermark, so truncation does not silently drop older candidates.

A timestamp group larger than the configured budget requires a larger caller budget (up to the hard bound); a backlog exceeding the request caps remains unavailable on retries. This bounded prerequisite does not claim unlimited catch-up. Supporting larger backlogs requires separately reviewed cursor/budget design, not silently advancing past them.

Remaining limits of history polling and a single watermark:

- Provider eventual consistency, backdated/late-visible messages and older history newly accessible after a scope/workspace change can occur below `since`; no exact-once/backfill guarantee is claimed for those cases.
- The host must scope its persisted cursor store to the correct Slack account/workspace. Credential rotation within an account is supported; swapping accounts with an existing unrelated watermark is not a migration strategy.
- The fixed horizon assumes reasonably aligned host/provider clocks. It closes scan-time timestamp buckets but cannot create a transactional Slack snapshot.
- `conversations.history` does not prove complete thread-reply coverage; that would require the separate replies transport. New reactions/edits to messages older than `since` are not new history events. Classification of observed rows is the retained source contract.

Slack protocol references: [cursor pagination](https://docs.slack.dev/apis/web-api/pagination/) and [conversations.history](https://docs.slack.dev/reference/methods/conversations.history/).

## Verification

All credentials, raw text, user/channel IDs and HTTP results are synthetic fixtures. Tests cover the real poller/store/aggregate path, multi-page and cross-channel continuity, restart against the persisted watermark, duplicate rows, rounded timestamp ties, arrivals straddling a frozen horizon, each request cap, valid/invalid terminal cursors, partial failures, credential errors/rotation, mapper admission failures, fixed-only diagnostics, unchanged durable IDs and late cancellation at every owned asynchronous port.

Final verification on 2026-10-03 with Bun 1.3.14:

- Focused adapter after mapper snapshot repair and composition: **72 passing tests / 1,497 assertions**, independently rerun by the reviewer.
- Composed engine regression through the repository-owned runner: **173 passing tests / 1,815 assertions** across the adapter, provider contract, poller, poller lifecycle, cursor store/lifecycle, registration, aggregation, channel inbox verb and PR89 workspace-trust disposition coverage (10 files).
- Composed Agent regression: **55 passing tests / 248 assertions** across the PR89 routine-schedule failure contract, bootstrap and routines-command fixtures (3 files).
- `bun packages/engine/scripts/typecheck.ts`: all three stages passed, including solution/test/script projects, consumer type tests and all four product workspaces. Repeated on the normal PR89 composition after the final mapper snapshot correction; no diagnostics.
- `bun run api:check`: repeated on the composition and passed; root, embed, terminal-shell and subpath baselines unchanged. The check reported API Extractor's bundled TypeScript 5.9.3 versus project 6.0.3 notice, gaxios fetch/preconnect and duplicate sql-js declaration warnings; it exited 0. SDK: 166 subpaths / 10,123 exports; terminal shell: 3 subpaths / 199 exports.
- `exports:check`, `subpath:declared:check`, `credential-scope:check`, `any:check` and `git diff --check`: passed. The fresh worktree required the normal `prepare:sdk` copy of its existing sql-js declaration before export coverage could pass; no export exception or source change was made for that preparation.
- Independent review additionally compared 200 deterministic synthetic cross-channel/tie/duplicate selection cases with a whole-bucket reference. Hostile Proxy rejection and asynchronous logger-rejection probes were reproduced, repaired and rerun with no escaped private marker or unhandled rejection. A later mapper-getter probe reproduced validation/projection drift; two negative-control tests failed against the prior implementation, then passed after the single-read snapshot repair. Independent direct probes confirm malformed digest rejection and exactly one read of each mapped field.

The initial typecheck caught a fixture-only spread cast error; it was corrected before the clean full and final affected runs. No dependency/lockfile changes were made. Whole-repository runtime tests, live Slack proof, production mapping and daemon composition are not established by this bounded proof. Commit/tree/blob receipts accompany the reviewed change; no generated public baseline file is changed.
