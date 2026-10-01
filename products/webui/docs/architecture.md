# Architecture

This document describes the current WebUI architecture and the boundaries that
should stay stable unless the daemon/SDK contract changes.

## Goals

GoodVibes WebUI is a full chat application and operator console over the
GoodVibes daemon. It should:

- make chat the primary surface, at parity with a modern chat application
- expose the operator surfaces over the same typed wire the terminal UI uses,
  as four places: Chat, Work (sessions, hosted sessions, the fleet,
  checkpoints, approvals, tasks, workstreams, CI watches), Library (memory,
  knowledge, review) and Personal (calendar, mail, occasions), with models,
  providers, sign-in, devices, check-ins and diagnostics in a settings dialog
- expose regular Knowledge/Wiki without leaking extension-specific Home Graph UI
- serve desktop and phone from one app: the phone gets a drawer layout of the
  same places, never a different mental model
- install from the browser (app shell offline, Web Push), with daemon data
  never cached
- stay on public SDK/browser seams with contract-typed method I/O
- avoid creating a second local state store for canonical daemon data

## Runtime topology

The WebUI has two important origins in development:

- Web/browser surface: `3423`
- Daemon/control-plane API: `3421`

Vite binds to the resolved WebUI host and port, then proxies API routes to the
daemon. The resolved WebUI binding comes from launch environment, `goodvibes web
--json`, or TUI settings fallback. See [Development](development.md) for exact
precedence.

The browser should usually talk to `window.location.origin`. Direct backend
origins are only for explicit development overrides.

## SDK boundary

Application code imports only published `@pellux/*` packages. The main seams:

- `@pellux/goodvibes-sdk/browser/knowledge` for the scoped browser SDK client
- `@pellux/goodvibes-sdk/auth` for `createBrowserTokenStore`
- `@pellux/goodvibes-sdk/contracts` for operator method input/output types
- `@pellux/goodvibes-contracts/generated/webui-facade` for the generated
  method-to-route table the transport layer is built from
- `@pellux/goodvibes-sdk/platform/voice/capture` and
  `.../platform/voice/wake/runtime` for browser audio capture and wake-word
  settings resolution
- `@pellux/goodvibes-sdk/platform/payments` and `.../platform/config` for
  payment-entry policy and config-key helpers
- `@pellux/goodvibes-transport-realtime` for the relay client

The WebUI does not deep-import package internals (`dist/` reaches are pinned
out by a test that resolves every imported subpath against the installed
packages) and does not point to a local SDK checkout for validation. The npm
packages in `node_modules` are the dependency under test, and the build
refuses to ship while the local SDK overlay (`bun run sdk:link`) is active.

`src/lib/goodvibes.ts` is the local client facade. It wraps auth, chat,
artifacts, realtime, and knowledge, plus one ergonomic `sdk.operator.*`
family per operator verb domain. The full verb-family inventory, with each
family's owner view and canonical state, lives in
[sdk-surface-matrix.md](sdk-surface-matrix.md); this document does not
duplicate it.

The transport under those helpers is generated, not hand-maintained. Which
operator methods have a plain REST binding, and at what path, comes from the
contract-emitted `WEBUI_METHOD_ROUTES` table in
`@pellux/goodvibes-contracts/generated/webui-facade`. The facade derives its
route table from that artifact minus the methods the browser SDK already
routes natively, so no route path or HTTP method is written by hand, and a
drift test pins the derived table against the generated artifact. Method
input/output types derive from the SDK's generated
`OperatorMethodInputMap`/`OperatorMethodOutputMap` via
`src/lib/contract-bridge-types.ts`, no hand-typed wire shapes, pinned against
the installed SDK's `operator-contract.json`.

Presentation tokens are generated, not hand-maintained:
`scripts/generate-presentation-tokens.ts` renders the SDK's shared presentation
contract into `src/lib/generated/presentation-tokens.ts` and the CSS custom
properties consumed by `src/styles/tokens.css`, so terminal, agent, and browser
share one visual vocabulary.

## Auth model

Auth belongs to the daemon.

- Session login posts through the daemon login route.
- Explicit tokens are accepted from the user and validated with the daemon.
- A `#pair=<token>` link (the QR from `goodvibes pair`) hands the token off
  automatically. The fragment is captured and stripped before the router can
  normalize the URL, the token is validated via `auth.current`, and a token
  the daemon rejects self-clears.
- Tokens live in the browser SDK token store under `goodvibes.webui.token`.
- When signed out, the shell is replaced by the signed-out gate rather than
  rendering behind failing calls.
- Browser code must not read `~/.goodvibes` files.
- GoodVibes secret refs are daemon-side downstream credential resolution, not
  WebUI auth.

## Chat model

Standalone WebUI chat uses daemon-owned companion chat, not operator session
continuation.

Primary APIs:

- `sdk.chat.sessions.list`
- `sdk.chat.sessions.create`
- `sdk.chat.sessions.update`
- `sdk.chat.sessions.close` (archive, distinct from delete)
- `sdk.chat.sessions.delete` (the honest hard delete)
- `sdk.chat.messages.list`
- `sdk.chat.messages.create`
- `sdk.chat.messages.retry` (regenerate; the prior reply is superseded and
  retained, never erased)
- `sdk.chat.messages.edit` (edit-and-branch; the old branch stays viewable)
- companion `chat.messages.steer` (send immediately, interrupting the
  in-flight turn; plain sends queue behind an active turn)
- `sdk.chat.events.stream`

Do not use `sessions.followUp` for plain companion chat. That path is for shared
operator session continuation and can spawn or queue agent work. Do not use
`sessions.messages.create` as a fallback send path for companion chat.

### Chat state

Daemon session/message data is canonical. Browser local storage is a cache for:

- recent companion chat sessions
- active companion chat session id

The cache exists so refreshes preserve a usable Recent list in the sidebar while the daemon list is
loading. Once `sdk.chat.sessions.list` succeeds, the daemon list is authoritative,
except for sessions created in the current browser run while the daemon list is
catching up.

One reducer (`src/lib/companion-sessions-state.ts`) is the single client-side
record of the sessions this browser knows about. Each entry is exactly one of
three states: created here and not yet confirmed by a daemon list, a cached
copy of a session the daemon already knows, or a tombstone hiding a session
pending a delete outcome or reported gone by the daemon. A tombstone carries
no session object by construction, so a hidden session can never leak back
into the rendered list, and a failed delete brings the row back rather than
leaving it falsely hidden. Once a daemon list has answered, its records win
outright; the only local copies still contributed are created-here sessions
the daemon has not returned yet.

The send path adds optimistic local user messages immediately and marks them
`local`, `sent`, or `failed` as daemon calls resolve. Assistant output streams
through companion chat events and is reconciled with daemon message history.

### Attachments

Companion chat attachments are real daemon artifacts:

1. Upload with `sdk.artifacts.create`.
2. Send `sdk.chat.messages.create(sessionId, { body, attachments })`.

Message sends must not carry provider/model routing. Routing belongs to the
chat session or daemon current model.

### Markdown and code

Assistant, chat, and Knowledge text render as Markdown with GFM support.
Code blocks support:

- syntax highlighting
- per-block copy
- whole-message copy
- optional decorative line numbers

Line numbers are UI-only and must not be copied with code content.

## Session union and steering

The Sessions kind of the Work view is the cross-surface session union, sessions started from the
terminal, agent, or browser, listed over `sessions.list`. The daemon caps that
list at the 50 most recent and the view states the cap instead of implying
completeness. Closed sessions are included by an explicit `includeClosed`
toggle, surfaced in the UI. A live session can be steered. A closed session
offers a follow-up, a new linked session, and is labeled as such, never
disguised as steering. This is the operator-session continuation surface. It
is distinct from companion chat and does not share its send path.

`sessions.search` is consumed by Chat's history search, scoped to
companion-chat sessions. It matches session id/title/project across full
history, while message-body search stays client-side over the sessions already
fetched. Its `includeClosed` defaults off there, deliberately the opposite of
the Work view's closed-session toggle, since a search surface hides dead sessions by
default while a full list shows them.

### Permission mode, context usage, cost, and compaction

A session's detail in Work surfaces per-session runtime state built directly against
the daemon wire:

- Permission mode (`src/lib/permission-mode.ts`) is session-scoped:
  `sessions.permissionMode.get`/`.set` answer only for the session that is the
  daemon's own live local runtime, and any other session id gets an honest
  `SESSION_NOT_LOCAL` unavailable state rather than a silent daemon-wide
  fallback (no daemon-wide value exists on the wire anymore). Live sync rides
  the `permissions` domain invalidation in `useRealtimeInvalidation.ts`,
  which revalidates the session-prefixed queries because the
  `PERMISSION_MODE_CHANGED` event carries no `sessionId`. The wire's mode
  vocabulary, mirrored from the contract's own enums:

  | Mode | Label | Settable |
  | --- | --- | --- |
  | `plan` | Plan | yes |
  | `normal` | Normal | yes |
  | `accept-edits` | Accept edits | yes |
  | `auto` | Auto | yes |
  | `custom` | Custom | no; it means the session runs a bespoke rule set, and the set verb's input enum deliberately excludes it |

- Context usage comes from `sessions.contextUsage.get`. The percentage is the
  token estimator's figure, always flagged `estimated` on the wire, and the
  chip's `~` prefix says so at a glance. A live `COMPACTION_CHECK` frame for
  the session is used only as a refresh trigger for that query, never
  rendered directly.
- Per-session cost comes from `cost.attribution.get`, windowed to the last 24
  hours with the session dimension. A session with no recorded usage in the
  window shows "no cost recorded", never a fabricated zero, and a row the
  daemon could not price is reported as unpriced.
- Compaction receipts (`src/lib/compaction.ts`,
  `src/hooks/useCompactionReceipts.ts`) are fed by the SDK's `compaction`
  runtime-event-bus domain (`COMPACTION_RECEIPT`, the mandatory
  post-compaction summary). Receipts render as distinct cards appended to the
  session transcript as they arrive live. There is no history endpoint for
  past receipts. This hook opens its own raw stream, scoped to the open
  session detail only (closed on unmount) to stay under the per-origin
  connection budget documented in `useRealtimeInvalidation.ts`.

## Memory model

The Library's Memory section reads and mutates the shared cross-surface memory store over
the daemon memory wire. Recall-honesty metadata from the daemon (search mode,
vector-index availability or its `platformLimitReason`, exclusion counts,
recall floor) renders verbatim. A literal-match fallback is labeled as one.
Deletion is verified. After a delete the view proves the record is gone rather
than just dropping it from a local list.

## Voice model

Voice rides the daemon's voice routes (`voice.tts.stream`, `voice.stt`,
provider/voice listing, `voice.status`) so browser, terminal, and agent get
identical provider behavior. Spoken replies batch and cap concurrent synthesis
with quiet retry; dictation always shows the transcript for review before
send. Voice configuration lives in the shared config tier, one config for all
surfaces. `voice.local.status`/`voice.local.install` provision the daemon's
managed local speech engines from the browser, with live install progress.

Wake-word detection is the exception to "everything runs on the daemon", and
the detector runs inside the tab. `voice.wake.provision` fetches the pinned model
artifacts onto the daemon, `voice.wake.model.get` serves them to the tab
(verified against a stated hash), and `onnxruntime-web` runs inference
locally, loaded in its own lazy chunk so a tab with the feature off never
fetches the runtime.

The `voice.wake.*` config rows are client-resolved per surface
(`voice.wake.surfaces.webui` is this tab's off-by-default opt-in), and
settings a tab cannot honor surface as verbatim resolver limitations or
blockers rather than being silently dropped. The host mounts at the app shell
(`useWakeHost` in `App.tsx`) because its microphone lifetime cannot be a
view's lifetime; while the surface opt-in is off it loads no model and never
calls `getUserMedia`.

## Installable app (PWA)

`public/manifest.webmanifest` + `public/sw.js` make the app installable. The
service worker caches the app shell only, never a daemon API response, so an
offline open loads the shell and shows the ordinary "can't reach the daemon"
state instead of stale data dressed as live. Web Push subscriptions go through
the daemon's `push.vapid.get` / `push.subscriptions.*` verbs
(`src/lib/push/`); registration is production-gated (`src/lib/pwa/`).

## Knowledge/Wiki model

The Knowledge page uses regular/base Knowledge routes through the scoped browser
Knowledge SDK.

Expected regular operations include:

- `knowledge.ask`
- `knowledge.search`
- `knowledge.status`
- `knowledge.sources.list`
- `knowledge.nodes.list`
- `knowledge.issues.list`
- `knowledge.map`
- `knowledge.item.get`
- `knowledge.packet`
- projection list/render/materialize through `operator.invoke` if needed
- ingest routes for regular Knowledge/Wiki operations

Home Assistant Home Graph is separate. The general Knowledge/Wiki surface should
not call `homeassistant.homeGraph.*`, pass Home Graph-specific scope flags, or
filter Home Graph data client-side. If extension records appear in regular
Knowledge by default, report the exact endpoint, payload, and record identifiers
to SDK/daemon maintainers.

## Provider/model model

Provider and model selection must follow daemon/provider registry semantics.

- Provider rows may represent runtime provider ids such as `openai-subscriber`.
- Model rows may expose catalog/provider registry keys such as `openai:gpt-5.5`.
- The UI should present provider and model separately.
- The model dropdown should update based on selected provider.
- Current daemon model selection is updated through daemon model APIs, not by
  attaching provider/model to chat message sends.

Provider/model helper logic lives in `src/lib/provider-models.ts`.

## Navigation and the settings dialog

`src/lib/router.ts` owns the URL schema: `?view=chat|work|library|personal|phone`,
`&tab=<section>` for the section inside Work, Library or Personal,
`&session=<id>`, and `&settings=<section>` while the settings dialog is open.
The shell (`src/components/shell/`) is the sidebar, header and account menu;
`nav.ts` is the map of destinations and their sections. There is no status
strip: the connection shows as the dot on the account avatar and in the
account menu's plain-words line, and a dropped connection raises a toast and a
thin banner.

Old `?view=` ids still resolve. The data views map to a destination and tab
(`LEGACY_VIEW_REDIRECTS`: sessions, fleet, approvals-tasks, workstream,
ci-watches and checkpoints to Work; memory and knowledge to Library; calendar,
mail and dates to Personal) and `useUrlState` rewrites such a link in place,
keeping its `#` fragment so a push notification's `#approval-action=` or
`#fleet-node=` survives. Admin, Providers, Principals and Check-ins are no
longer pages: `LEGACY_SETTINGS_VIEWS` opens the settings dialog on Account,
Models and providers, People and channels and Check-ins.

The settings dialog (`src/components/settings/dialog/sections.ts`) has seven
pages: General, Account, Models and providers, Voice, Notifications, Memory
and Permissions. Each page holds one or more sections (for example Account
holds Sign-in, Devices and pairing, and People and channels). Every SDK config
namespace belongs to exactly one section, and a namespace the daemon reports
that this build does not list lands in Advanced, so no setting is unreachable.
The settings cover:

- auth login and token management, passkey step-up
- local auth status and daemon diagnostics
- runtime/config snapshots through the schema-driven editors
- appearance: theme, density, code block line numbers, and the opt-in GoodVibes
  Neon theme
- service/network posture where exposed by daemon APIs

## Realtime and invalidation

The app uses realtime events as invalidation and rendering signals, not as the
only source of truth. It loads snapshots/lists first, then refreshes affected
queries on relevant events.

App-wide invalidation rides ONE multiplexed SSE stream (connected only after
sign-in) rather than per-view connections, because per-view streams starved
the browser's per-origin connection pool. The daemon multiplexes every
requested domain onto that stream (`/api/control-plane/events?domains=...`)
and each frame's event name is its domain; the hook invalidates that domain's
query keys and never renders straight from a frame. A second raw stream
carries session updates. The subscribed domains and what a frame on each
revalidates:

| Domain | Revalidates |
| --- | --- |
| `tasks` | The task queue |
| `permissions` | Approvals, the session-prefixed queries (permission mode and context usage ride the sessions prefix), and permission rules |
| `providers` | Provider inventory and status |
| `knowledge` | Knowledge status, sources, and refinement |
| `control-plane` | Control status/snapshot |
| `fleet` | The live fleet snapshot and the archive, so the Work list and the needs-you count update on the event instead of the next poll |
| `ops` | The power (keep-awake) state and the memory-pressure tier chip | The narrow exceptions that open their own scoped streams are
the open session detail's compaction-receipt stream (closed on unmount) and
the Work view's approvals `approval-update` subscription, which is a fixed-name
wire event rather than a domain frame; both stay within the connection
budget.

Chat streams are session-scoped through companion chat SSE helpers.
Intermediate stream iteration events should not be treated as complete turns.
Stream drops surface as honest degraded states (reconnecting / paused /
expired) with real retry, per-effect stream epochs preventing stale handlers
from acting, and views that lose their stream fall back to honest polling.

## Transport routes and the relay

Two transports can answer a request (`src/lib/relay-connection.ts`):

- direct, an ordinary `fetch` against the WebUI origin (or a configured
  backend origin), the unchanged LAN/co-located path
- relay, `createRelayClient` from `@pellux/goodvibes-transport-realtime`,
  which tunnels calls end to end encrypted through a rendezvous relay when
  this device cannot reach the daemon directly. It requires a stored relay
  pairing (`src/lib/relay-pairing.ts`, delivered by QR or a `#relay=`
  hand-off fragment) and is opt-in and probe-driven, never the default.

The relay tunnel also carries live event streams; a dropped-chunk overflow
surfaces as a visible relay-overflow notice, never a silent gap. The daemon
gates state-changing relay calls behind a WebAuthn step-up assertion. A
mutating call without a fresh assertion gets a 401, the registered prompter
runs the passkey ceremony, and the call retries once with the assertion
attached. If the operator cancels or no passkey exists, the 401 surfaces
honestly.

## Non-goals and boundaries

- Do not read TUI or daemon private files from browser code.
- Do not point WebUI to a local SDK checkout.
- Do not add client-side Home Graph filtering as a fix for regular Knowledge
  scoping issues.
- Do not create a second durable config or knowledge store in WebUI.
- Do not silently move the dev server to another port.
- Do not use storage-only message APIs as chat send fallbacks.
