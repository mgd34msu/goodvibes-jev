# SDK surface matrix

This matrix records the public SDK/daemon surfaces WebUI uses. It is a
maintenance aid. When a route moves, update the row, and when a new surface
lands, add one.

## Rules

- Import browser code from published `@pellux/*` npm packages only. A test
  resolves every imported subpath against the installed packages and refuses
  `dist/` deep reaches.
- Prefer `@pellux/goodvibes-sdk/browser/knowledge` as the client entry point.
- Never hand-write a method route. The route table derives from
  `@pellux/goodvibes-contracts/generated/webui-facade`'s `WEBUI_METHOD_ROUTES`
  minus the methods the browser SDK routes natively, and a drift test pins the
  derivation.
- Do not use Home Assistant Home Graph routes for regular Knowledge/Wiki.
- Do not pass provider/model on chat message sends. Routing belongs to session
  creation/update or the daemon current model.

## Matrix

| Surface | Public SDK or route | WebUI owner | Canonical state | Notes |
| --- | --- | --- | --- | --- |
| Auth current user | `control.auth.current` via the browser SDK | Sign-in gate, app boot, Admin | Daemon/session auth | Detects the signed-in state; a rejected explicit token self-clears. |
| Login | daemon `/login` through the SDK/fetch facade | Sign-in gate, Admin | Daemon local auth | Username/password auth remains daemon-owned; no cookies. |
| Token store | `createBrowserTokenStore({ key: 'goodvibes.webui.token' })` | SDK client setup | Browser SDK storage | Do not read daemon auth files. |
| Pairing hand-off | `#pair=` fragment + `pairing.handoff.complete`, `pairing.posture.get` | Sign-in gate, hand-off offers modal | Daemon pairing service | Fragment stripped immediately; offers (push/relay/passkey) reported per outcome. |
| Relay transport | `@pellux/goodvibes-transport-realtime` `createRelayClient` | `relay-connection.ts` | Stored relay pairing | Opt-in, probe-driven; tunnels unary calls and SSE, end to end encrypted. |
| Step-up | WebAuthn ceremony + step-up assertion header | `stepup.ts`, Admin, relay mutations | Daemon verifier | Mutating relay calls retry once with a fresh assertion; a refusal surfaces honestly. |
| Control status | `control.status` | app boot, Admin | Daemon | Version/service posture. |
| Control snapshot | `control.snapshot` | Admin diagnostics | Daemon | Diagnostic JSON, not editable state. |
| Accounts snapshot | `accounts.snapshot` | Admin/Providers diagnostics | Daemon | Provider account posture. |
| Provider list | `providers.list`, `providers.get`, `providers.usage.get` | Providers, Chat composer | Daemon | Runtime providers and model inventory. |
| Models | `models.list`, `models.current.get`, `models.current.set` | Providers, Chat composer | Daemon provider registry | Real contract entries with REST bindings since the 2.0.0 pin; provider-first, model-second. |
| Chat sessions | `sdk.chat.sessions.list/create/update/close/delete` | Chat sidebar | Daemon companion chat | Close archives; delete is the honest hard delete; the cache prunes deleted ids. |
| Chat messages | `sdk.chat.messages.list/create/retry/edit`, companion `chat.messages.steer` | Chat transcript, composer | Daemon companion chat | Retry/edit supersede and retain, never erase; steer interrupts the in-flight turn. |
| Chat events | `sdk.chat.events.stream(sessionId, handlers)` | Chat transcript | Daemon SSE | Drives streaming and invalidation. |
| Chat history search | `sessions.search` (kind `companion-chat`) | Chat search | Daemon session spine | Titles across full history; message bodies stay a client-side search over loaded sessions. |
| Artifacts create | `sdk.artifacts.create({ filename, mimeType, dataBase64, metadata })` | Chat attachments | Daemon artifact store | Upload first, then attach artifact id to message. |
| Knowledge ask/search | `sdk.knowledge.ask`, `sdk.knowledge.search` | Knowledge | Regular Knowledge store | No Home Graph scope flags by default. |
| Knowledge status | `sdk.knowledge.status()` | Knowledge/Admin | Regular Knowledge store | Readiness and counts. |
| Knowledge list surfaces | `knowledge.sources.list`, `knowledge.nodes.list`, `knowledge.issues.list` | Knowledge | Regular Knowledge store | Scoped browser Knowledge SDK/operator invoke. |
| Knowledge item/map/packet | `knowledge.item.get`, `knowledge.map`, `knowledge.packet` | Knowledge | Regular Knowledge store | Report upstream if Home Graph records leak. |
| Knowledge projections/ingest | projection and ingest method ids via typed invoke | Knowledge/Wiki | Regular Knowledge store | Only regular contracts; separate from chat attachments. |
| Sessions union | `sessions.list` (+ `sessions.get`, `sessions.messages.list` via browser SDK) | Sessions | Daemon session spine | Daemon-capped at 50 most recent, stated in the UI; `includeClosed` is an explicit toggle. |
| Steer / follow-up / detach | `sessions.steer`, `sessions.followUp`, `sessions.detach` | Sessions, Fleet, Hosted | Daemon session spine | Steer only while live; follow-up on closed sessions is offered AS a follow-up; steer stamps this surface. |
| Permission mode | `sessions.permissionMode.get/set` | Sessions toolbar | Daemon session runtime | Session-scoped; `custom` is read-only; `SESSION_NOT_LOCAL` renders as unavailable. |
| Context usage | `sessions.contextUsage.get` | Sessions detail chip | Daemon token estimator | Always estimated, marked `~`; a live compaction check only triggers a refetch. |
| Session cost | `cost.attribution.get` (24h, session dimension) | Sessions detail chip | Daemon cost attribution | No row means "no cost recorded", never a fabricated zero. |
| Session changes | `sessions.changes.get` | Sessions detail | Daemon workspace diff | Per-hunk review with comment/revert sheets. |
| Session rewind | `rewind.plan`, `rewind.apply` | Sessions detail | Daemon rewind service | Plan previews and mints a single-use confirm token; apply is confirmed. |
| Hosted sessions | `sessions.hosted.list/create/attach/kill` (+ detach beacon) | Hosted view | Daemon-hosted session loop | Detach policy defaults to the daemon's own setting; live frames ride the shared turn/tools domains. |
| Fleet | `fleet.snapshot` + `fleet` runtime-event domain; `watchers.stop` | Fleet, Workstream | Daemon process tree | Actions render only where the wire supports them; stop exists only for watcher nodes. |
| Checkpoints | `checkpoints.list/diff/create/restore` | Checkpoints | Daemon checkpoint store | Diff is against the live tree; restore is confirmed; a noop create is reported plainly. |
| Memory | `memory.records.*`, review-queue verbs | Memory | Shared cross-surface memory store | Recall-honesty metadata renders verbatim; deletes are verified. |
| Calendar | `calendar.*` (CalDAV-backed) | Calendar | Daemon calendar store | ICS import/export; unconfigured points at the `surfaces.calendar.*` keys. |
| Mail | `email.inbox.list/read`, `email.draft.create`, `email.send` | Mail | Daemon mail handler | Not-available/needs-setup/error render distinctly; the browser holds no credential. |
| Dates | `occasions.*` (list, pending, answer, resolve, interview, gift history) | Dates | Daemon occasions service | All proximity/nudge rules are server-side; this surface is pull-only. |
| CI | `ci.watches.list/create/delete/run`, `ci.status` | CI view | Daemon CI service | Every job's conclusion is listed; violations render verbatim. |
| Check-in | `checkin.config.get/set`, `checkin.run`, `checkin.receipts.list` | Check-in view | Daemon check-in service | Saves are confirmed because config can enable proactive contact. |
| Principals | `principals.list/create/update/delete`, `channels.profiles.list/set/delete` | Principals view | Daemon identity registry | Deletes are permanent and confirmed; an honest `deleted` boolean, never a phantom 200. |
| Tasks | `tasks.*` | Approvals view | Daemon | Cancel only when cancellable; retry only for failed/cancelled. |
| Approvals | `approvals.*` (+ `selectedHunks` on approve) | Approvals view, Fleet inline | Daemon | Per-hunk approve sends an index array; the daemon computes the applied result. |
| Realtime invalidation | raw multiplexed `/api/control-plane/events?domains=...` + session stream | app-wide | Daemon runtime bus | Invalidate off frames, never render from them; snapshots/lists stay authoritative. |
| Voice | `voice.status`, `voice.providers.list`, `voice.voices.list`, `voice.stt`, `voice.tts`, `voice.tts.stream` | Chat composer, Voice settings | Daemon voice routes | One shared voice config tier across surfaces. |
| Local voice | `voice.local.status`, `voice.local.install` | Voice settings | Daemon-managed local engines | Install progress polls while the mutation is in flight. |
| Wake word | `voice.wake.status`, `voice.wake.provision`, `voice.wake.model.get` | Wake settings, app-shell host | Daemon-provisioned models, in-tab inference | Model bytes verified against the stated hash; `voice.wake.*` config is client-resolved per surface. |
| Web Push | `push.vapid.get`, `push.subscriptions.*` | Admin (Notifications & install), hand-off offers | Daemon push service | Requires a secure (HTTPS) context; subscription reconciled on open. |
| Config | `config.get`, `config.set` (one key at a time) | Settings modal | Daemon config | Schema-driven editors from the SDK's `CONFIG_SCHEMA`; secrets masked and write-only. |
| Presentation tokens | SDK shared presentation contract via `scripts/generate-presentation-tokens.ts` | build-time generation | SDK contract artifact | Generated `src/lib/generated/presentation-tokens.ts` + CSS custom properties; never hand-edited. |
| Local auth status | daemon local auth route | Admin | Daemon | Show user/session metadata only, never raw secrets. |
| Phone device node | `PhoneNodeClient` against the daemon base URL | Phone view | Daemon device-node registry | Announces only capabilities this browser genuinely has; every capture is person-confirmed. |

## Explicit non-surfaces

| Non-surface | Why it is excluded |
| --- | --- |
| `homeassistant.homeGraph.*` | Home Graph is an extension surface, not regular Knowledge/Wiki. |
| `sessions.followUp` as a companion-chat send path | It is a legitimate Sessions-view surface for continuing a closed operator session (see matrix above), but it can spawn/queue agent work, never use it to send plain companion chat. |
| `sessions.messages.create` fallback | Can persist a user message without a daemon-owned assistant turn. |
| `~/.goodvibes` browser reads | Private daemon/TUI implementation state. |
| local SDK checkout | Does not validate the installed npm contract; the build refuses to ship while the overlay is linked. |
