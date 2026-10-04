# Private Discord inbox adapter (THE-113)

## Scope and pinned source

- Issue: [THE-113](https://linear.app/the-artificery/issue/THE-113/hoist-private-discord-inbox-adapter), a bounded THE-13 prerequisite related to THE-18.
- Target base: `mgd34msu/goodvibes-jev` `df70645d7e5088736a0e7ea662b58e8ed121ce11`.
- Pinned source: [`src/daemon/handlers/inbox/providers/discord.ts`](https://github.com/mgd34msu/goodvibes-daemon/blob/254699bf5d834cdca41436211ada1ae32bf89258/src/daemon/handlers/inbox/providers/discord.ts), commit `254699bf5d834cdca41436211ada1ae32bf89258`, Git blob **`d14cfa423c37ca8eb5fc182e47c73907fc058a3c`**. Retrieved through the repository connector and verified with `git hash-object` before implementation.
- Private target: `packages/engine/sdk/src/platform/intake/providers/discord.ts`.
- Synthetic behavioral fixtures: `packages/engine/test/intake-discord-adapter.test.ts`.

This implements the existing `InboundProviderAdapter` and exercises the real `InboundPoller`, `InboxCursorStore` and aggregate reader. It adds no public export, manifest entry, API baseline, default registration, production caller, live provider request, credential operation, dependency or lockfile change. Import and construction are side-effect free. It does not depend on the unpublished THE-109 triage or THE-111 normalization work and does not touch ledger/Agent/TUI, execution admission/PR56, or THE-49 IMAP.

## Transport evidence and unresolved production composition

Checked official Discord documentation on 2026-10-03:

- The [User Resource](https://docs.discord.com/developers/resources/user) and its [official source](https://raw.githubusercontent.com/discord/discord-api-docs/main/developers/resources/user.mdx) document `GET /users/@me` and **POST** `/users/@me/channels` (Create DM). Neither documents the source adapter's **GET** `/users/@me/channels` bot DM enumeration. No unsupported listing call is copied, and absence from these references is not presented as a live server experiment.
- [Get Channel Messages](https://docs.discord.com/developers/resources/message#get-channel-messages) returns message history newest-first, accepts `before`, `after` or `around` exclusively, and allows limits from 1 to 100. This adapter requests 50 rows and uses only `before` on every page. No Gateway connection, channel creation or other mutation is performed.
- The [Snowflakes reference](https://docs.discord.com/developers/reference#snowflakes) describes unsigned 64-bit decimal IDs with creation milliseconds above the low 22 bits and the Discord epoch. The [Message Resource](https://docs.discord.com/developers/resources/message#message-object) also exposes a timestamp; it does not promise timestamp/ID equality. Its example even has different values. The adapter therefore makes the snowflake the sole ordering for history cursors, the fixed horizon and `receivedAt`, instead of assuming equivalence.

Consequently **a complete host DM catalog is a required port**. It receives the resolved self ID, exclusive `beforeMs` and abort signal, never the bot credential. It must return `complete: true`, that exact `accountId`, and the complete intended DM/group-DM channel set through the horizon. Incomplete, malformed, over-bound or account-mismatched catalogs withhold the poll. Only DM type 1 and group-DM type 3 are admitted; duplicate channel IDs are scanned once.

This is an assertion the host must establish, not something a boolean proves. A cache of recently seen channels is insufficient. Production composition must define durable gap-free discovery, account/channel-scope cursor ownership, catalog readiness and activation/backfill behavior. No supported production catalog implementation or live Discord availability is established here. A host that later adds previously missing channels below an existing global watermark must deliberately reconcile/backfill them; this adapter cannot detect a false completeness assertion.

## Required ports and privacy boundary

1. Read-only intake credential store: resolve `surfaces.discord.botToken` on every poll, with no cached credential or self identity. Blank credentials are unconfigured, lookup failure leaves configuration unknown, and downstream failures after resolution are configured/unavailable. Token resolution is not proof that Discord accepts it.
2. HTTP port: await the complete GET operation, response decoding and cleanup. It owns transport deadlines, response-byte caps, rate-limit handling, cancellation and production HTTP requirements such as Discord's [client User-Agent](https://docs.discord.com/developers/reference#user-agent). The adapter sends the same signal and a Bot authorization header only to its two fixed Discord API path forms. It never substitutes global `fetch`.
3. Complete DM catalog port, described above, with its own awaited resource lifecycle.
4. Trusted item mapper: admit the canonical SHA-256 first-16-hex sender digest, display-safe subject (at most 200 characters), and PII-stripped body preview (at most 500). It receives raw sender/channel/text locally. A shape check cannot establish privacy semantics. Null/undefined, malformed, thrown or rejected mapping withholds the entire result. No raw-text, regex-redaction or normalization fallback exists.

Each mapped primitive is read exactly once into immutable locals, validated and projected from those same locals. Extra fields never cross the adapter boundary. Required string checks precede digest regex checks, so arrays/coercible objects/numbers are refused. Sender fallback remains the channel ID when author is absent; the output sender and optional routing seam only receive its digest. Stable IDs preserve **`discord:<channel>:<message>`**, including the original provider identifiers, so dedup identity is unchanged.

## Exact source/check accounting

Line references below are to the pinned 276-line source, not floating daemon main. These checks are protocol equality, arithmetic, field shape or lifecycle decisions; no lexical message-meaning or urgency/spam heuristics are introduced.

| Pinned source/check | Target disposition |
| --- | --- |
| L36-40, L123-124: API v10, provider ID, credential key, realtime cadence | Retained (`discord`, `surfaces.discord.botToken`, 30 seconds). Constants/factory are private to the source module, not a public barrel. |
| L108-118: global GET, Bot authorization, decoded response, 401/non-success refusal | GET/header semantics retained behind required injected HTTP. Any non-success withholds the whole result with a fixed operation diagnostic. No credential/status/body/path values are echoed. |
| L128-134, L252-271: credential resolution and true/false/unknown configuration | Retained, with value-free credential failure and explicit false only for missing/blank token. |
| L136-146: self lookup best-effort | Repaired: self lookup or shape failure withholds the poll; silently turning mentions/reactions into DMs is not allowed. |
| L149-150: GET DM listing, type 1/3 filter | Unsupported-list claim removed. Required complete account-scoped host catalog supplies bounded type 1/3 channels. No undocumented REST listing or account data access is performed. |
| L79-96: own-message/nonempty reaction, then structured self mention, then truthy referenced message, else DM | Precedence retained. Malformed typed fields fail closed. Message text, emoji labels and urgency/spam words do not affect kind. A null referenced message remains DM as in the source. |
| L199: bot authors skipped | Retained before classification. This includes self rows marked `author.bot: true`. Therefore this is legacy message-snapshot classification, not a claim of real reaction-event ingestion. |
| L99-105, L191-197, L241-243: snowflake conversion, timestamp-preferred fallback and oldest-ID selection | Deliberately repaired: canonical positive unsigned-64 decimal snowflakes only; use ID-derived milliseconds exclusively and numeric minimum ID for pagination. Missing/malformed IDs fail rather than becoming epoch-zero. Optional timestamp metadata is ignored even when it disagrees. This is not literal timestamp parity with the source. |
| L158-170: per-channel page size and exclusive after/before parameters | Page size is fixed at 50 independent of item budget. All pages use only `before`; the first is the zero-low-bit snowflake at the frozen exclusive horizon, never an after/before combination. |
| L177-182: per-channel failure skipped | Repaired: any failed/incomplete channel withholds all items so another channel cannot advance the shared watermark past missing history. |
| L184-229: empty/short pages, raw-page pagination, since/item-budget stops and 20-page cap | Empty/short terminal pages and raw minimum IDs retained; stop on floor only once the raw page reaches `since`. Add strictly decreasing exclusive cursors and channel binding checks. Item-budget early exits are replaced with bounded complete scans; exhausted request caps explicitly fail. |
| L202-218: sender fallback, mapping, stable ID, receivedAt, unread | Sender fallback/ID/unread retained; mapping delegated to required privacy-admission port; receivedAt intentionally canonicalized to snowflake as above. |
| L219-220: optional route | Retained best-effort, awaiting the result; fixed-only warning on rejection, awaiting and suppressing even an optional asynchronous logger's rejection. |
| L232: ready/empty by count | Retained only after complete scan and complete mapping; unavailable never carries partial items. |
| L130, L143-144, L178-181, L234, L274-275: rendered external errors/identifiers | Replaced with closed diagnostics held by private WeakMap identity. Even rejected hostile Proxies are not inspected for message, prototype or string conversion. |
| Missing cancellation/ownership checks | Added before/after all owned asynchronous ports; all work stays awaited. Poll options are read once inside the guarded operation, and catch never rereads caller options. Throwing options or signal accessors cannot make the adapter reject. |

No separate Discord provider test file is listed in the pinned inbox inventory. This slice adds offline behavior fixtures rather than claiming unrelated daemon gateway/composition suites were ported.

## Bounded complete-window argument

A poll captures its integer clock cutoff once before credential/catalog/HTTP work. The first `before` snowflake has zero low bits at that millisecond, excluding the entire cutoff bucket. Subsequent page cursors strictly descend numerically. Every row must be below its requested cursor, and an explicit channel binding must match. The canonical watermark and stop test use the same snowflake milliseconds, including when every raw row on a page is an excluded bot. No `after` is sent.

A successful scan covers all catalog channels within these bounds:

- At most 200 catalog rows, 20 history pages per distinct channel and 200 history pages total
- 50 messages per response; positive caller item budget at most 1,000
- At most `limit + 1` distinct candidate rows retained; each eligible candidate message body at most 40,000 characters
- Terminal evidence must be an empty/short page or reaching the since floor. A final full cap-boundary page without that evidence is unavailable, never silently truncated

The existing poller persists `max(receivedAt)` and later asks strictly above it. Returning a newest-first partial batch would lose older unreturned rows and other channels. Instead, scan completely and retain the globally oldest `limit + 1` distinct candidates. If the omitted row shares the budget-boundary timestamp, exclude that entire timestamp group. An oversized oldest group that cannot fit is explicitly unavailable; otherwise return the whole oldest groups. A subsequent poll/restart can safely resume strictly above the committed watermark for this complete observed window.

This is bounded catch-up, not unlimited history synchronization. Without an initial cursor, history over these page limits stays unavailable; activation therefore needs a deliberate reviewed initial-history policy. A tie bucket beyond the caller budget requires a larger budget within the cap or a new cursor design. Host clock alignment, provider eventual consistency/deletion/access changes and late-visible/backdated history are not transactional snapshot guarantees. The catalog assertion and correct account-scoped cursor remain essential. Matching the current self ID does not bind the already-persisted provider cursor to an account: same-account token rotation is supported, but switching accounts requires the host to bind/reset or migrate the cursor deliberately.

The upstream reaction branch is retained for eligible observed rows, but bot-self rows are excluded and new reactions/edits on messages older than `since` are not new history. Actual reaction events need a distinct event transport/cursor design. Neither accepting group-DM enum values nor a synthetic fixture demonstrates live bot access to group DMs.

## Verification

All accounts, tokens, message contents, catalogs, transport responses and identifiers in fixtures are synthetic. No live Discord calls occurred. Commands use Bun 1.3.14 and existing shared dependencies without new installation.

- Focused adapter suite: 97 tests / 2,562 assertions passing, including real poller/store close/reopen, cross-channel ties, oldest-prefix continuity, bot-only pages, duplicate rows, horizon timing, per-channel/global cap boundaries, withheld mappings, partial aggregate preservation and stop/drain at credential, self, catalog, history, mapper, route and asynchronous logger stages.
- Independent reviewer: 150 randomized multi-channel histories with repeated strict-watermark polling, ties, horizon, hostile exceptions, mapped getter single reads and late logger cancellation, 6 tests / 43,977 assertions passing. The reviewer found a throwing poll-options getter escape; a durable negative regression now covers that repair and single-read options. The final independent combined run passed 103 tests / 46,539 assertions after an additional source-fidelity repair keeping absent-author sender fallback out of reaction classification.
- Engine intake regression through the repository-owned runner: 178 tests / 2,804 assertions across adapter, provider contract, poller/lifecycle, cursor store/lifecycle, registration, aggregation and inbox verb fixtures (9 files).
- Negative controls intentionally reversed the oldest-prefix ordering, removed whole-timestamp-bucket selection, rendered raw external diagnostics, and removed cancellation checks. All four targeted tests failed. Removing bucket selection persisted two rows where only one complete bucket was safe; the durable cross-channel fixture caught it. Restoring the exact reviewed source returned the focused suite to green.
- Full `bun packages/engine/scripts/typecheck.ts`: all 3 stages passed (forced solution/tests/scripts, consumer type tests, all four product workspaces), no diagnostics. After the final author-identity correction, a forced SDK/test-project rebuild also passed with no output or diagnostics.
- `bun run api:check`: passed after normal `prepare:sdk`; all root/embed/terminal-shell and subpath baseline hashes unchanged. SDK: 166 subpaths / 10,123 exports; terminal shell: 3 subpaths / 199 exports. API Extractor reports its bundled TypeScript 5.9.3 versus project 6.0.3 notice and existing duplicate sql-js / gaxios fetch-preconnect declaration warnings, but exits 0.
- `any:check`, `credential-scope:check`, `subpath:declared:check`, `exports:check`, `architecture:check` and `git diff --check`: passed.

The first full type run caught a fixture-only exact-optional-property error, corrected before the clean full/final affected runs. An initial `prepare:sdk` attempt before declaration emission correctly refused the absent fresh-worktree dist directory; the ordinary compile-then-prepare sequence succeeded without a source exception. Commit/tree/blob receipts accompany the final four-path change.

Whole-repository runtime coverage, production privacy admission, production DM discovery, daemon composition and live provider proof remain outside this prerequisite.
