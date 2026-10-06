# Changelog

All notable changes to GoodVibes WebUI will be documented in this file.

This project uses semantic versioning with `vMAJOR.MINOR.PATCH` git tags.

## [Unreleased]

### Fixed

- General settings now renders the engine-owned terminal palette as a 13-choice
  selector, with `goodvibes` as the fresh default. Changes persist through the
  connected host's client-local config store; browser appearance and other
  terminal installations remain independent.

- Session context shows the engine's known ceiling, source and accepted-input
  lower bound without promoting fallback or consensus estimates into capacity.
  Model changes supersede stale context reads; unsupported hosted scopes remain
  unavailable instead of showing another runtime's usage.

- Session follow-up and steer receipts now retain the returned input ID and exact
  delivery state. Queued HTTP responses stay queued; session updates and a fallback
  poll reconcile delivery, completion and failure without resending. Session,
  account and relay changes retire local drafts and stale responses.

- Session close, reopen and permanent delete retain the originating account and
  selected-detail lifetime. Interrupted requests never continue under another
  account or dismiss a newer selection. Unknown outcomes remain locked across
  detail reopen until an explicit read-only refresh; mutations are never replayed
  automatically. Deletion checks the target when the capped session list omits it.

- Work can inspect real native, durable and captured-worktree contract responses.
  Original native goals and ordered criteria, recorded semantic outcomes, separate
  transport retry progress and durable/input provenance remain read-only.
  Genuine engine-route fixtures guard strict wire validation and rendering.

### Added

- Work contract details can explicitly request cancellation with a partial-files
  warning. Intents are single-flight and tied to the selected account and detail.
  Ambiguous responses never replay a mutation; retry requires refreshed state and
  a new confirmation. Acknowledgement does not claim child cleanup is complete,
  and a retained contract without a live runner can report no cancellation.

- Read-only contract inspection in Work: goals, original requests, criteria and
  recorded readings, group/unit/attempt trees, check evidence, escalation history
  and terminal results. Existing process controls remain reachable.
- Contract caches follow authentication lifetime, cancel late responses and
  refresh from the contracts event domain, including events during initial load.
  Generated engine schemas reject malformed evidence before rendering.

## [2.0.0] - 2026-10-01

### Changes

The web UI is redesigned from top to bottom. It talks to the same daemon
and SDK as 1.13.20; old links and bookmarks still work.

- **Four places instead of thirteen.** The sidebar holds New chat, Search,
  Work, Library and Personal, with your Recent chats underneath. Work brings
  sessions, agents, processes and everything waiting on you into one list
  with Needs you first. Library holds memory, knowledge and the review queue.
  Personal holds the calendar, mail and occasions. Old `?view=` links open
  their new home.
- **One settings dialog.** The Admin view, the Providers view and the config
  modal become one searchable dialog with seven pages: General, Account,
  Models and providers, Voice, Notifications, Memory and Permissions. Pages
  that used to stand alone, such as Devices and pairing or Usage, are
  sections inside the page they belong to, and old settings links land on
  them.
- **A calm, slate look.** One accent color, Geist type at a comfortable
  size, rounded surfaces, glass dialogs over a blurred backdrop, and light,
  dark or automatic themes. GoodVibes Neon stays as a theme you can switch
  on from the account menu.
- **Chat reads like a conversation.** A greeting and real starting points on
  a new chat, one composer that shows the model and effort in words, tool
  activity folded into one line you can open, and calm code blocks that
  scroll inside their frame.
- **The status strip is gone.** Connection, theme, devices, people,
  check-ins and sign out live in the account menu; the avatar's dot shows
  whether the daemon is reachable.
- **Room for detail.** When a detail, a message or an event opens on the
  right, the sidebar folds to an icon rail and comes back when it closes.
  Pinning the sidebar keeps it open.
- **Built for phones.** The sidebar becomes a drawer, sheets rise from the
  bottom, and no screen scrolls sideways.
- **Plain words.** Every confirmation asks one question in one sentence, and
  empty states say what to do next.
- **Tests guard behavior.** A layout check runs every major screen on phone
  and desktop for sideways scroll and clipped text, a contrast test checks
  every text color in each theme, and older tests that pinned markup or
  wording now check what a person sees and does.

## [1.13.20] - 2026-09-30

### Changes

- **The pin moves to sdk 2.1.0.** The settings schema lists the bundled
  themes for display.theme (goodvibes, goodvibes-neon, catppuccin,
  tokyonight, dracula, nord, gruvbox, one-dark, rosepine, solarized, github
  and system) and carries display.treeGlyphs and the
  behavior.notificationsMetadataOnly notification setting.
- **Every open dependency advisory is closed.** undici, nanoid, postcss,
  browserslist, baseline-browser-mapping and both brace-expansion lines move
  to patched versions; bun audit reports no vulnerabilities.

## [1.13.19] - 2026-08-23

### Changes

- **The pin moves to sdk 2.0.23**, which carries the honest calendar-auth
  mapping, the fixed error hints, the routes-folded provider aggregates, and
  the reasoning-effort surface this release's composer control reads.

- **The page never scrolls; every pane owns its scroll.** The app shell is
  locked to the viewport: the sidebar scrolls its own nav, each view scrolls
  inside the workspace, and in chat only the transcript scrolls, with the
  composer pinned below it. Before this, sidebar overflow stretched the whole
  document, the status bar landed mid-page and rode along with scroll, and
  the composer sat wherever the document happened to put it.
- **The status bar is pinned to the viewport bottom**, above the sidebar in
  stacking order, with a reserved lane so no pane's last item hides under it.
- **Hosted sessions open on plain-HTTP origins.** Ids minted with
  crypto.randomUUID crashed with "crypto.randomUUID is not a function" on
  insecure origins, where the browser does not expose it; minting now falls
  back to crypto.getRandomValues, which insecure origins do have.
- **Error banners speak the daemon's words.** A failed request showed the
  bare status line ("400 Bad Request") while the response body carried the
  actionable reason (for the calendar: an expired Google credential and the
  offer to start a fresh consent). The body text now wins.
- **A provider with any usable auth route reads as configured**, even when
  the daemon's aggregate flag disagrees with its own routes (observed with a
  healthy subscription sign-in beside an unset API-key env var).
- **Reasoning effort is selectable in the composer.** A compact control next
  to the model picker lists the effort levels the current model actually
  accepts (served per model by the daemon from sdk 2.0.23) and persists the
  choice through the same verb that switches models. No control renders for
  models with no ladder or against daemons predating the field.
- **The sidebar wordmark stops abbreviating.** The sidebar is wide enough for
  the complete "GOODVIBES" at its established size; the ellipsis truncation is
  gone and the size is unchanged.
- **Configured providers lead every provider list.** The composer's model
  picker and the Providers sidebar group configured providers first,
  alphabetical within each group, instead of burying them in a long
  alphabetical list of unconfigured ones.

## [1.13.18] - 2026-08-23

### Changes

- **The mic's "needs https" notice no longer camps over the composer.** On a
  plain-HTTP origin the reason bubble was rendered permanently, visually
  covering the message box for the whole session. Permanent conditions now
  hide the bubble by default; tapping the crossed mic toggles the reason
  open and closed, and the hover title still carries it. Transient feedback
  (recording, transcribing, errors) keeps its bubble.

## [1.13.17] - 2026-08-22

- Platform runtime 2.0.22: a dead subscription login is stamped and shown as
  ended everywhere instead of green; a near-expiry token refreshes silently
  before the send; this surface adopts the running daemon again (the version
  gate had refused it since sdk 2.0.0 and silently ran local-only). No webui
  code change; the pin is the fix.

## [1.13.16] - 2026-08-21

- Platform runtime 2.0.21: a rejected OpenAI subscription token recovers
  through one shared refresh-and-retry before any error is surfaced, and a
  session that truly ended is reported as a subscription sign-in problem,
  never an API-key one. No webui code change; the pin is the fix.

## [1.13.15] - 2026-08-21

- **Cache-bust values match the version and can never drift again.** The
  service-worker and asset cache keys derive from the package version, and a
  `cache-bust:check` gate in the build chain fails the build if they drift,
  so a deploy can no longer serve stale assets under a new version.
- Platform runtime 2.0.20: the pin rides the payments boot-recovery sdk
  cycle; the config schema is regenerated against it. No webui behavior
  change was needed for it.

## [1.13.14] - 2026-08-21

- Platform runtime 2.0.19: the pin rides the checkout-seam and wake-verb-fix
  sdk cycle. The daemon-side wake model fix in that cycle is what repairs
  this surface's wake feature; no webui code change was needed for it.
- **Pair a phone by pointing its camera at the terminal's QR** (platform
  runtime 2.0.19): the sign-in screen gains a camera scanner (native
  BarcodeDetector with a bundled fallback decoder) that reads every payload
  form the family mints, including the terminal's light-on-dark QR, and
  feeds the exact sign-in path manual entry uses. This replaces the retired
  Android companion app's scanner.
- Session state is one reducer over a normalized entry list: a session
  hidden by an in-flight delete structurally cannot render a stale copy, and
  the sidebar order is byte-identical to before (verified by differential
  fuzzing against the old logic).
- Device node: capability execution is idempotent across a lost completion
  report or a dead tab; a stored marker turns redelivery into a report-only
  path.
- ChatView: turn lifecycle is one typed phase value reset atomically on
  session switch, ending stale error and badge carryover. The reset exempts
  the one switch a send itself causes: a first message with no active
  session creates the session mid-send, and the switch to it no longer wipes
  the in-flight turn (the Stop control stayed visible only by luck of the
  race before; a regression test drives the full send-creates-session flow).

## [1.13.13] - 2026-08-15

### Changes

- Platform runtime 2.0.17: subscription sign-ins are platform-wide (shared tier), the edit tool schema is strict-gateway compatible (oneOf -> anyOf), and the keep-awake sleep inhibitor is requested with
  `--no-ask-password`, so a polkit refusal can no longer register an
  interactive auth prompt on a terminal (the fix lands in the terminal
  products and daemon 1.28.19; no WebUI behavior change, the pin rides the
  train).

## [1.13.12] - 2026-08-08

### Changes

- Platform runtime 2.0.14: spoken output strips markdown before synthesis
  (fenced code is announced, not read), post-wake capture ends when the
  speaker stops on real microphones (rolling silence floor + breath-tolerant
  endpointing, new `voice.wake.speechRetriggerMs` setting), and every wake
  capture leaves a diagnostics receipt. The daemon this client talks to
  (1.28.17) carries the same behavior; no WebUI behavior change, the pin
  rides the train.

## [1.13.11] - 2026-08-07

### Changes

- Platform runtime 2.0.13: post-wake capture ends when the room goes quiet
  (ambient-measured silence floor, settable; the capture ceiling can be
  turned off), and the daemon this client talks to (1.28.16) carries the
  same behavior. The runtime also registers its barrel subpaths so the
  compiled terminal products stop playing a build-order lottery at load.
  No WebUI behavior change, the pin just rides the same train.

## [1.13.10] - 2026-08-06

### Changes

- Platform runtime 2.0.11: an unnamed voice request goes to the provider
  the user configured, local engines first when provisioned, instead of
  the first cloud provider on the internal registration list. The daemon
  this client talks to (1.28.13) carries the same fix.

## [1.13.9] - 2026-08-05

### Changes

- Platform runtime 2.0.10: the event stream resumes from where it actually
  left off instead of replaying the previous turn's tail, and a
  turn-completion frame from a turn this client did not start is refused.
  A fresh turn's real output can no longer be dropped as leftovers, and the
  previous turn's final message can no longer appear twice.
- One busy hosted turn no longer freezes every session's heartbeat, so
  cross-visible sessions stay honestly "active" while another surface is
  mid-turn.
- The daemon this client talks to (1.28.12) now requires the exec boundary
  for the conversational sessions it hosts, and no background command skips
  the safety checks anywhere on the platform.

## [1.13.8] - 2026-08-05

### Changed

- Platform runtime 2.0.9: occasion views carry subject attribution and
  acknowledgment state (an acknowledged occurrence renders as heard, not
  pending), the retired final-stretch setting leaves the generated schema,
  and the session activity label holds still instead of streaming tool
  arguments.

## [1.13.7] - 2026-08-05

### Changed

- **Profile reads work against an up-to-date daemon.** The daemon's profile
  answers carried more than the published contract allowed, so strict clients
  refused them; the contract and the answers now agree, held together by a
  conformance test (platform runtime 2.0.8).
- Session views render the agent's daemon-hosted conversations with their
  messages. Session event streams are render-grade and scoped to their
  session.

## [1.13.6] - 2026-08-02

### Changed

- **A chat session is filed as a chat.** Channel-originated sessions in the
  cross-visible session list carry the platform's new `channel` kind instead
  of reading as project sessions rooted in a filesystem path; this client
  understands the new kind, so a Telegram conversation renders correctly in
  the session views (platform runtime 2.0.7).
- The daemon settings file is rewritten only by the daemon, this client
  migrates its in-memory view of renamed settings and leaves the file bytes
  untouched, so updating the webui can no longer rewrite settings out from
  under an older running daemon (platform runtime 2.0.7).

## [1.13.5] - 2026-08-02

- Changed: payment budget amounts display and edit as the plain amounts they
  are. The renamed platform keys (`payments.budget.perPurchaseCeiling` and
  friends, platform runtime 2.0.5) hold what you typed: enter `100`, read
  back `100`, with money fields detected by their schema type instead of a
  name pattern, and the stored-units hint line gone because there is nothing
  to hint about.
- Fixed: two test suites opened real network sockets to a daemon that does
  not exist in a test environment, and the runtime's own teardown of those
  refused connections could detonate after the tests finished, the CI flake
  class from this train. Every suite now answers those calls in-process; a
  sweep of all 184 test files individually confirms zero network-error lines.

- Changed: the platform runtime is 2.0.4, which makes watcher-snapshot
  writes atomic and quarantines a corrupt snapshot instead of crashing the
  process that reads it.

## [1.13.3] - 2026-08-01

- Changed: the platform runtime is 2.0.3, which classifies wildcard bind
  hosts (`0.0.0.0`, `::`) as local rather than public in the transport
  layer. The web UI dials the daemon by page origin, so it was not affected
  by the wildcard refusal; it picks up the corrected runtime all the same.

## [1.13.2] - 2026-08-01

- Changed: the platform runtime is 2.0.2, which removes the last pre-split
  in-process daemon composition remnants from the shared bootstrap. The web
  UI was not affected by the packaged-bundle crash those remnants caused in
  the terminal products; it picks up the cleaned runtime all the same.

## [1.13.1] - 2026-08-01

- Fixed: importing settings that include `display.themeMode` no longer reports
  an "unknown key" warning. The key is declared in the platform configuration
  schema (SDK 2.0.1); the web UI ingests it like any other `display.*` setting.

## [1.13.0] - 2026-08-01

The web UI installs with everything else now. Until this release it was the one
part of GoodVibes you had to go and get: the daemon, the terminal app and the
agent all arrived from one `curl`, and the browser surface arrived from a build
you ran yourself.

The release lane packs `dist/` into a versioned, checksummed asset:
`goodvibes-webui-bundle-<version>.tar.gz` plus a `SHA256SUMS.txt`, and attaches
both to the GitHub release. The suite installer fetches it on the same terms as
every binary in the suite (a missing manifest entry is a hard failure, never a
skip), unpacks it beside the binaries, and points the daemon at it. There is no
fourth binary and no fourth service: the daemon serves the bundle on its own
listener, same origin as its API, which is also why the browser's same-origin
policy is a non-issue and no CORS allowlist has to be widened.

Nothing new is exposed to your network by installing it. The daemon's shipped
binding is loopback and the installer does not change it, so a fresh install
serves the web UI to that machine only; reaching it from another device is a
deliberate separate act (`goodvibes-daemon webui enable --lan`), printed in the
install receipt.

`scripts/pack-bundle.ts` is what builds the asset, and it is deterministic:
sorted entries, zeroed ownership, epoch timestamps, no gzip header stamp, so
two runs over the same build produce byte-identical archives and the digest in
the manifest keeps meaning "the bytes this release built". It refuses to pack a
`dist/` with no `index.html` rather than publishing a bundle nobody can serve.

Sessions gained a Hosted Sessions view: a conversation whose loop runs inside
the daemon itself rather than inside this browser tab, so it keeps going after
the tab that started it closes. The toolbar's "New session" form takes a
workspace path, an optional title, and a detach-policy choice that defaults to
whatever the daemon is already configured to do; a created session attaches
immediately and renders its live output the same way a local session does.
"End session" ends it outright, including a session whose policy would
otherwise let it survive every client leaving, confirmed first, since it is
immediate and affects every other attached client too. Closing or reloading the
tab no longer leaves an orphaned attachment behind: a `pagehide`/hidden-tab
beacon fires a best-effort detach with `keepalive: true` so the browser
delivers it after the page itself is gone, rather than relying on a React
cleanup effect that never gets to run.

The hosted view is honest when its live stream is down. The session list falls
back to a real periodic refresh (15 seconds while the stream is down, 60 as a
safety net while it's live) instead of quietly going stale, a banner says so
while it's happening, and a reconciliation pass keeps the attached session's
own status in sync with the freshest list row, closing the gap where a
session that had already ended kept rendering its message composer as if still
live. A passive detach (switching rows, leaving the view) that fails to reach
the daemon now says so with a toast instead of failing silently, so a browser
that never actually detached does not stay listed as attached with no way to
tell why.

Settings gained the row for `hostedSessions.promoteInboundConversations`, off
by default, which hands an inbound channel conversation (Telegram, Slack,
email, any other configured channel) to the daemon to host from its first
message onward, instead of letting it live only inside the surface process
that received it.

Ships against `@pellux/goodvibes-sdk` 2.0.0. The daemon's unified inbox verb,
`channels.inbox.list`: one merged, newest-first feed across every channel
provider (Slack DMs, Discord messages, email threads), distinct from the
mail-specific verbs the Mail view already uses, arrives with a real REST
binding this app's generated route table picks up the same way it picks up
every other table-routed verb. No view calls it yet; it is reachable the
moment one is built, not aspirational.

## [1.12.1] - 2026-07-30

Maintenance re-pin, no webui feature changes. The platform runtime moves from
1.20.0 to 1.21.0, carrying forward the daemon's lifecycle and boot-honesty
fixes: the auto-updater no longer rolls a healthy daemon backwards and now
tells the owner over a working channel when update checks keep failing, a
fatal boot error prints what went wrong on the terminal instead of dying
silently, an unreadable setting is skipped loudly instead of killing the
daemon or being silently ignored, state migrated by a newer component names
the version floor instead of crashing an older reader, `--daemon-home`
actually governs the daemon's state directory, and a compiled daemon no
longer dies at startup over an absent optional package. Fresh registry
install, no local overlay; generated config-schema, config-ownership and
presentation artifacts regenerated against the published package, picking up
the new `update.alertAfterFailedChecks` setting in the schema mirror. README
badges and index.html's favicon cache-bust move to 1.12.1 / SDK 1.21.0.

## [1.12.0] - 2026-07-30

The dates the daemon has been tracking now have a place to be seen. Occasions,
birthdays, anniversaries, travel plans with their date ranges, get a panel of
their own, pulling the daemon's `occasions.*` verbs into view: upcoming
occurrences with their real next date, anything still awaiting an answer or
stuck on an unresolved conflict, an in-progress gift interview, and the store's
own disclosure counts. A pending nudge shows only the proximity word the daemon
already computed for it, never a raw date. That is the same restraint the daemon's own
nudge wording observes, kept intact here rather than loosened because a browser
had a date field handy. Nothing in this panel pushes a notification anywhere;
that stays with Telegram and the agent, unchanged.

The wake word works in this browser tab now, on one microphone path shared with
dictation rather than a second capture stack fighting the first for the same
device. A single arbiter decides who holds the microphone: press-to-talk stands
the wake listener down and waits for it to release before opening anything, and
a second concurrent open is refused outright. The listener stays off unless
`voice.wake.surfaces.webui` is explicitly turned on: no model fetch, no
session, no permission prompt until it is. Once it is, the pinned model
comes from the daemon in verified chunks, checked against its published
checksum before anything is created from it; a mismatch refuses rather than
loading a model that could never detect correctly. On a confirmed wake: a
chime, the utterance goes through the same transcription call dictation uses,
and the result lands in the composer or submits per
`voice.wake.autoSubmit`. An indicator is always on screen while the microphone
is open: a statusline chip or a persistent banner, never a toast that could
dismiss itself while listening continues.

Both the wake listener and dictation now go through the speex noise filter and
the voice-activity gate for real, rather than the resolver declaring the
capability false. Scoring only starts once the daemon reports the gate itself
provisioned and checksum-verified, so a missing artifact still blocks instead
of running ungated behind a row that claimed otherwise. The set of daemon-served
audio components this app recognizes is now derived from the generated
contract instead of a hand-copied list, so a component the daemon adds is
picked up automatically rather than refused the moment the two drift.

The two ONNX Runtime backends this app can pick between now share a single
wasm binary instead of shipping one apiece: the WebGPU build already contains
the CPU engine, so the wasm-only build bought nothing and is gone. Switching
backends costs no extra download, and a tab set to `webgpu` without
`navigator.gpu` falls back to the CPU provider already inside the one binary
it has rather than fetching a different engine. `dist` drops from 40 MB to
27 MB.

Underneath all of it, the platform runtime moves from 1.19.1 to 1.20.0,
catching up the release this app had skipped, with the generated
config-schema and config-ownership artifacts regenerated against the merged
surface and verified unchanged beyond the new occasions settings the dates
panel needed.

## [1.11.0] - 2026-07-29

You can give the daemon a payment card from this interface now. Settings has a
card entry form that takes the number, expiry, security code and cardholder
name, sends them once to the daemon's own secret store, and never reads them
back. There is no method anywhere that returns them, so nothing can display
them again, here or elsewhere. What you see afterwards is the brand, the last
four digits, the expiry month and year, and whether every required field is
filled. A virtual card with a hard issuer cap bounds what any leak could cost to
one number you can cancel; a real card number cannot be capped by anything this
software does, and the form says so where you choose.

With the card comes the spending it is bounded by. The payment settings, daily
limits, per-purchase ceilings, how long a purchase waits before it goes through,
which channels get told, and how the security code is handled, are editable
here, with money entered in ordinary units (12.50, not 1250) and converted using
the right number of decimal places for your currency rather than assuming two.
The daemon's timezone is now set from a searchable list of real zones instead of
typed as free text, because that is the setting that decides when a daily budget
rolls over, and a typo in it silently means "UTC".

The owner profile has a home. The daemon keeps a single document describing you,
how you like to be addressed, the people and places it should recognise, the
standing preferences it should apply, and until now nothing in this browser
could show it. Admin has it now: you can read it, edit it, see which entries the
daemon wrote itself versus which you wrote, and undo a change. Every write says
who made it and on whose authority.

Mail no longer hides messages it could not read. When your account returns a
message the daemon cannot parse, a broken encoding, a malformed header, the
inbox now lists it with the reason it gave, instead of leaving it out. This
matters most in the case that used to be worst: a window where every message
failed to parse looked exactly like an empty inbox, and the screen told you the
account had answered normally with nothing in it. It now says nothing was
readable and shows you why, message by message.

The inbox is also ordered correctly. Messages sort by the sequence number the
server assigns, not by the date written into the message by whoever sent it,
so nobody can pin their mail to the top of your inbox by putting a date far in
the future in it.

Secrets you had not been told about are masked. The platform split the mail
password reference into separate incoming and outgoing ones, and the outgoing
one was new enough that nothing here knew to hide it; it would have been shown
in full in Settings. It is masked now. The way this was found is the part worth
keeping: this app checks every setting the daemon declares against the list of
things it treats as secret and fails its own build when something credential-
shaped is not on it, rather than relying on anyone noticing.

Under all of it, the platform runtime moved from 1.18.1 to 1.19.1, and that
release stopped letting this app guess. Requests that were missing a field the
daemon requires used to compile here and be refused there, and the refusal
arrived as a generic failure with nothing to say which field was wrong. Those
requests are now checked before they are sent. Two were genuinely broken: the
knowledge wiki could ask for a page in a form the daemon always rejected, and
the payment card list quietly dropped which card the daemon would actually
charge. Both are fixed, and where this interface is talking to a daemon newer
than itself, it now says so plainly instead of sending something that fails.

## [1.10.0] - 2026-07-27

The platform runtime this interface is built against moved up six releases, from
1.15.0 to 1.18.1. It had been left behind on every bump since, which meant this
was the one surface still compiled against months-old types with nobody having
checked what that cost. It cost one thing: the settings catalogue this app keeps
in step with the runtime had gone stale. Regenerated, so the eleven settings for
letting several of your machines share inbound work, the two for how the daemon
times and rolls back its own updates, and the twenty-five for the daemon's own
mailbox and calendar connection are now visible and editable here like every
other setting, with anything secret masked, as always. That last group is what
lets you finish mail setup from this interface at all: they were keys the daemon
read and no surface could show. Nothing else in the app changed shape; the whole
suite, the build and the browser tests pass against the new runtime exactly as
they did against the old one.

Mail now has a screen. The daemon has published verbs for reading an inbox,
opening a message, saving a draft to the account and sending, and nothing in
this interface had ever shown them, so there is now a Mail view beside Calendar
with an inbox you can filter by count, date and unread, a reader that opens in
the side panel, and a composer that can reply, save a draft into the account's
own Drafts folder, or send. Sending asks you to confirm the recipients first,
because it cannot be taken back.

It is honest about what it can actually do. A message's plain text is what gets
shown: if the sender also included an HTML version, the view says so and leaves
it unrendered, so nothing written by a stranger can style, lay out or load
anything inside the page holding your session. Attachments are listed with their
type and size and nothing more, because the daemon publishes no way to fetch
one, and a download button that could not download would be a lie. And when the
surface cannot answer, either because the daemon you are talking to does not
serve mail, or because you have not yet given it an account, it says which of
those it is and what the next step would be, and the Send and Save draft
controls go inactive with the reason beside them rather than staying lit to fail
on click. As of this release the first case is no longer the normal one: the
platform serves mail itself now, so a current daemon answers these verbs, and
"no account connected yet" is the state you should actually expect to see.

Admin gained a panel reporting whether mail and calendar are actually working:
ready, or the specific thing that is missing. It reports only. There is no
credential field anywhere in it. Accounts and passwords are set through Settings,
which writes them to the daemon and its secret store, so what you configure keeps
running with this browser shut and is the same account the terminal and the agent
use. No mail or calendar credential is ever sent to, or held by, your browser.

## [1.9.0] - 2026-07-26

A phone can now be a set of things the agent is able to ask for, and this web
interface is how you do it. Open the new Phone view on a phone, pair it once,
and that phone's cameras, screen, location, clipboard, and small device actions
(show a notification, open a link, buzz) become capabilities the agent can
request. It never takes any of them quietly: every capture and every action asks
you first, and the page keeps an honest log of everything it actually served.
What a phone announces is only what that browser can really do: a capability
whose API is missing, or that the browser withholds on this address, is not
offered at all, and the desktop says why it is unavailable rather than showing a
control that would fail.

Saying "always allow" on one of those prompts is now a real, durable answer
rather than a setting you cannot find again. The new grants panel lists every
standing permission with the phone it belongs to, the capability it covers, when
it was given, when it expires, and how often it has been used, each with a
revoke control. It also shows the recent record of permissions given, used,
revoked and expired, and lets you run the cleanup sweep and read back exactly
what it removed. It reads the daemon's own record, so what you see is what is
actually honoured. Captures are kept for 24 hours by default and then deleted.

Settings gained three new groups, each configurable rather than a bare switch:
Paired Phone Capabilities (twelve settings covering how permission is asked for,
location precision, clipboard reading, how long captures are kept, and the
limits on paired phones and standing permissions), Watchers for the new trigger
family (nineteen settings; triggers ship off, and nothing watches anything
until you turn them on), and Voice, which now holds wake-word detection beside
the local speech engines (twenty-five settings). Wake-word detection is not
operable in this build and says so in the setting itself rather than appearing
to work: your choice is remembered for the release that adds microphone capture.
Every one of those settings is reachable and searchable in the settings
workspace like the existing ones, which is now pinned by tests.

Ships against `@pellux/goodvibes-sdk` 1.15.0.

## [1.8.1] - 2026-07-25

Updated the bundled GoodVibes platform runtime to 1.14.0, keeping the web
interface on the same platform version as the rest of the products.

That update changes how messages arriving from connected channels are handled:
they now get a conversational answer, and work is proposed and confirmed rather
than started automatically. It also stops progress notifications from resending
the whole accumulated log, stops one incoming message from starting two agents,
and makes notification links point at an address another device can reach.

The web interface's own behavior is unchanged in this release.

## [1.8.0] - 2026-07-25

Tool activity now stays with the message that produced it. Previously the tool
calls a turn made were visible only while the turn was running and then
disappeared once it finished, leaving an assistant message with no record of
the work behind it. Completed tool calls are now folded into the assistant
message itself: a single-tool turn renders one compact entry, and a multi-tool
turn folds behind an expandable summary that counts what actually ran ("3
tools · read×2, exec") rather than an invented total. Long results show a
preview with the full text behind a second expand, and failed calls are marked
as errors.

Because this record is built from the stream this browser tab watched live, it
is present only for turns that ran while the tab was open; it is never
reconstructed or guessed for older turns.

Ships against `@pellux/goodvibes-sdk` 1.13.1.

## [1.7.7] - 2026-07-25

Ships against `@pellux/goodvibes-sdk` 1.12.1, which makes crash-recovery
offers respect live writers and makes snapshot retirement act on exactly one
identified snapshot. No webui-side code changes.


## [1.7.6] - 2026-07-24

Ships against `@pellux/goodvibes-sdk` 1.12.0, which introduces declare-once
product storage surfaces, the ask-then-retire recovery lifecycle, and the
cross-process workspace-checkpoint lock. No webui behavior depends on those
paths (verified: the webui holds no session-persistence call sites), so this
release carries the platform pin plus documentation.

### Changed

- README rewritten around the screenshot tour: accurate cross-machine access
  story (Tailscale or same-LAN with firewall policy), honest release-model
  note, corrected version badges, descriptive alt text on all screenshots.

### Added

- MIT `LICENSE` file and a `license` field in `package.json`. The repo
  claimed MIT in its badge without shipping the license text.


## [1.7.5] - 2026-07-18

Ships against `@pellux/goodvibes-sdk` 1.11.4, which closes the secrets-store
key-mismatch class (race-safe key generation, pre-write key revalidation,
key fingerprints in store envelopes). No webui-side code changes.

## [1.7.4] - 2026-07-17

Ships against `@pellux/goodvibes-sdk` 1.11.3. Compaction-continuation user
messages, the compactor's re-injected instruction handoff after every
automatic compaction, now render as a closed "Compaction handoff" disclosure
in session transcripts instead of the full multi-kilobyte instruction wall.
The detection header is pinned byte-for-byte against the SDK's
`COMPACTION_HANDOFF_HEADER` export by a contract test.

## [1.7.3] - 2026-07-17

Ships against `@pellux/goodvibes-sdk` 1.11.2, which now carries the shared
release toolchain (`@pellux/goodvibes-toolchain`) as a dependency of its own.
The separate direct toolchain pin in this repo's `devDependencies` is gone;
`release-gate.ts` resolves the toolchain transitively through the SDK
package instead. Releases are now zero-touch: a green CI run on a release
commit pushed to `main` tags the commit and creates the GitHub release page
itself, with no manual step afterward. SDK 1.11.x remains release-engineering
only: no wire-contract changes affecting the WebUI.

## [1.7.2] - 2026-07-17

Ships against `@pellux/goodvibes-sdk` 1.11.1 and adopts the platform's shared
CI/CD system: the local release gate is a thin wrapper over the published
`@pellux/goodvibes-toolchain` (sdk-pin-gate), CI single-sources its Bun
version, and a workflow-shape test suite pins the pipeline's structure. The
SDK 1.11.x releases are release-engineering only: no wire-contract changes
affecting the WebUI.

## [1.7.1] - 2026-07-16

Ships against `@pellux/goodvibes-sdk` 1.10.1. Alignment patch: the SDK's 1.10.1
release contains type-level additions only, with no wire-contract changes
affecting this repo.

### Changed

- Updated `@pellux/goodvibes-sdk` to `1.10.1` (fresh lockfile from the registry;
  generated config schema verified unchanged).

## [1.7.0] - 2026-07-16

Ships against `@pellux/goodvibes-sdk` 1.10.0. This release adds the admin
memory diagnostics panel and the one-act local voice setup flow, and re-pins
from the local dev-link build onto the published 1.10.0 package.

### Added

- **Memory diagnostics panel.** The admin Memory panel renders `ops.memory.get`:
  the daemon's live memory records surfaced for inspection rather than left
  opaque.
- **One-act local voice setup.** The voice-settings popover offers a single-action
  setup for a local speech runtime, with size-labeled components before install,
  live per-component install progress polled from the daemon's status, an install
  receipt on completion, an honest reason plus a Retry action on a retriable
  download failure, an honest report on an unsupported platform instead of an
  install that cannot succeed, and honest omission of the local section entirely
  against an older daemon build whose `voice.local.status` 404s.

### Changed

- Re-pinned `@pellux/goodvibes-sdk` from the local dev-link build to the published
  `1.10.0` registry package; removed the dev-link `file:` overrides so all nested
  `@pellux` resolutions come from the registry.

## [1.6.0] - 2026-07-14

Ships against `@pellux/goodvibes-sdk` 1.9.0. This release rolls up the pairing,
fleet, task-graph, voice, memory-provenance, and remote-access work accumulated
since 1.5.0, adds the fleet review acceptance checklist, and re-pins from the
local dev-link build onto the published 1.9.0 package.

### Added

- **Fleet review acceptance checklist.** A reviewed WRFC chain or sub-deliverable
  node now renders the latest review's verdict, score, and cycle count, plus the
  acceptance checklist itself: each requirement listed with whether it was
  independently verified (not just scored), the reviewer's evidence, and how it
  was exercised. The verdict is the controller's gate-inclusive `passed`, not the
  reviewer's own claim. An empty checklist is called out as a gate failure rather
  than shown as an accepted deliverable, and a node renders nothing before its
  review has completed.
- **Pairing depth.** QR and token pairing, hand-off between surfaces, single-use
  pairing tokens, and push-subscription reconcile on connect, with the daemon's
  own posture and reason text rendered verbatim.
- **Fleet attention and observed agents.** Best-of-N pick and merge-conflict
  states join approval/input as one waiting-on-a-human class; externally-launched
  coding-agent sessions appear as read-only observed rows (visibility only, never
  counted as own agents); the `acp-agent` kind renders with the generic kind
  badge.
- **Fix-phase task graph.** A fix workstream's dependency graph renders and stays
  legible on a phone.
- **Local voice provider.** The speech-to-text provider selection shows a local
  option beside ElevenLabs, driven by the SDK's `voice.local.*` surface.
- **Turn and queue control.** A running tool call can be cancelled; queued
  messages stay editable and deletable before they send.
- **Memory provenance and receipts.** A provenance chip proves the real
  `TURN_COMPLETED` wire convention on and off; consolidation receipts route the
  records they concern to the existing review queue.
- **One-action remote access.** A single action stands up Tailscale HTTPS serving
  for reaching the surface across the LAN.

### Changed

- Re-pinned `@pellux/goodvibes-sdk` from the local dev-link build to the published
  `1.9.0` registry package; removed the dev-link `file:` overrides so all nested
  `@pellux` resolutions come from the registry.

## [1.5.0] - 2026-07-13

Ships against `@pellux/goodvibes-sdk` 1.8.0. This release rolls up the
approvals, costs, fleet, receipts, and settings work accumulated since 1.4.0
and re-pins from the local dev-link build onto the published 1.8.0 package.

### Added

- **Approvals depth.** Approval cards remember tiers, support
  deny-with-a-reason, render exec prompts as answerable cards with the whole
  command visible, and a durable-rules view lists the remembered decisions.
  The card trusts the daemon's recorded block: remembered tier, stored
  reason, and delivered answer all render from the wire, not from client-side
  guesses.
- **Cost provenance.** Every visible dollar figure names its source
  (`costSource` plus an as-of date) straight from the wire, with no
  client-side derivation. An explicit price-unknown marker replaces silent
  zeros, and manual pricing is a one-action fix with a real editor for
  `pricing.modelPrices` in Settings.
- **Fleet headlines and the stall tell.** Fleet rows and details render the
  read-model's derived per-node headline and the quiet-stall marker, so a
  wedged agent is visible at a glance.
- **Receipts on connect.** The daemon's undelivered notices are consumed
  exactly once on connect; feature announcements ride the same connect-time
  queue and their URLs are clickable.
- **CI fix sessions.** Accepting a CI watch's fix offer opens the spawned fix
  session directly; the opened id is a real session, and a failed spawn says
  so instead of presenting a dead button.
- **Domain-grouped settings.** Settings adopt the SDK's dissolved feature
  model: domains replace the enablement bucket, driven end to end in e2e,
  including the pricing-editor and approvals-depth journeys.

### Changed

- Re-pinned `@pellux/goodvibes-sdk` from the local dev-link build to the
  published `1.8.0` registry package; removed the dev-link `file:` overrides
  so all nested `@pellux` resolutions come from the registry.
- Phone-width checkpoint and task mutations complete through their confirm
  sheets; the stale limitation note is gone from the docs.

### CI

- A build-time check bans internal planning identifiers from tracked text,
  wired into the build so a violation fails it.

## [1.4.0] - 2026-07-11

Ships against `@pellux/goodvibes-sdk` 1.7.0. This release rolls up the SDK
adoption and surface work accumulated since 1.3.0 and re-pins from the local
dev-link build onto the published 1.7.0 package.

### Added

- **Permission mode control.** The Sessions view now shows and lets you
  change the daemon's permission mode (Normal/Auto/Custom/Plan/Accept edits)
  from a toolbar chip and a touch-first picker sheet. The mode is daemon-wide
  (`permissions.mode` config key, read via `config.get()` / written via
  `config.set()`), so the TUI and every WebUI tab agree: a change from
  either surface reflects everywhere over the existing `permissions`
  realtime domain.
- **Context-usage chip and compaction receipts.** A session's detail pane
  now shows a compact context-usage indicator and renders the SDK's
  post-compaction receipts (strategy, token/message counts before and after,
  quality grade, outcome) as distinct cards in the transcript, fed by the
  SDK's real `compaction` runtime-event domain. Both are honest about
  absence: a session with no observed compaction activity shows "not
  observed yet" rather than a fabricated number.
- **Schema-driven settings surface.** Settings render from a build-time
  snapshot of the SDK's `CONFIG_SCHEMA` plus the feature-flag registry
  (`FEATURE_FLAGS` / `FEATURE_FLAG_CONFIG`), with typed editors per key and
  feature-unit grouping. The snapshot keeps the node-only config barrel out
  of the browser bundle; a schema change that was not regenerated fails the
  build.
- **QR pairing and relay sign-in.** QR pairing is the primary sign-in path,
  with relay-pairing intake and an honest via-relay connection state.
- **Step-up approvals.** A step-up UI with per-call-site step-up UX and
  relay-overflow surfacing in the transport layer.
- **Session review cockpit.** A multibuffer review surface with per-hunk
  approve / comment / revert, a unified-diff parser, and the ability to
  comment on a hunk and steer it back into the session.
- **Session rewind.** Plan preview, confirm, apply, and undo for rewinding a
  session.
- **Best-of-N pick-winner.** Pick a winning attempt from the Fleet view.
- **Fleet attention routing.** Attention-first sibling sort, needs-attention
  helpers, a live attention badge over the fleet subscription, and a
  needs-input deep link that focuses the blocked fleet node.
- **Principals and channel profiles admin view.**
- **Check-in view** (`checkin.config.*`, `checkin.receipts.list`,
  `checkin.run`).
- **CI watches view** (`ci.status`, `ci.watches.*`).
- **Checkpoint confirm-restore.** Confirm-aware restore enriched with a
  restore preview.
- **Approval push notifications.** Allow / Deny actions on approval push
  notifications, and phone mutations behind touch-first confirm sheets.

### Changed

- Re-pinned `@pellux/goodvibes-sdk` from the local dev-link build to the
  published `1.7.0` registry package; removed the dev-link `file:` overrides
  so all nested `@pellux` resolutions come from the registry. No behavior
  change from the pin itself: the surfaces above were validated end to end
  against the published package, including a live-daemon smoke that boots a
  real daemon from `1.7.0`.
- The webui transport layer is now derived from the generated contract
  facade, and approval attribution, compaction-strategy fallback, and
  sandbox model-judgment annotations render in the session transcript.

### CI

- Removed `continue-on-error` from the Coverage step so no workflow step can
  report green over a red result.

## [1.3.0] - 2026-07-09

Ships against `@pellux/goodvibes-sdk` 1.6.1.

### Added

- **Fleet archive view.** The Fleet view can now toggle between the live
  fleet and the session archive of finished agents/swarms (`fleet.archived.list`).
  Finished processes can be archived one subtree at a time from the detail
  pane, or all at once from the toolbar (`fleet.archive` /
  `fleet.archiveFinished`); archived processes stay browsable with full
  usage/cost detail and can be restored to the live view (`fleet.unarchive`).
  The daemon refuses to archive subtrees with running members: the refusal
  reason surfaces as a toast, never a silent no-op.

### Changed

- Sessions benefit from SDK 1.6.1 daemon behavior: immediate compact-and-retry
  when a provider rejects a request as exceeding the context window, learned
  per-model context ceilings, and agent-completion notices that deliver
  exactly once instead of repeating with escalating urgency tags.

## [1.2.2] - 2026-07-08

Maintenance release on `@pellux/goodvibes-sdk` 1.5.0.

### Changed

- Validated against SDK 1.5.0: the daemon now compacts a session immediately
  when the model itself reports its context window filled up, and honors
  persistent per-model context-window overrides. No WebUI code change:
  session behavior improves through the daemon; model context windows shown
  in the picker reflect any configured override automatically.

## [1.2.1] - 2026-07-07

Maintenance release on `@pellux/goodvibes-sdk` 1.4.1.

### Changed

- Validated against SDK 1.4.1, which makes permission settings the sole
  authority for command-class risk in the daemon's exec tool. No WebUI
  behavior change: the WebUI has no exec surface. This release keeps the
  ecosystem pinned to one SDK version.

## [1.2.0] - 2026-07-07

The turn-control release, on `@pellux/goodvibes-sdk` 1.4.0.

### Added

- **Stop actually stops.** The Stop button now issues the daemon's new
  server-side cancel (`companion.chat.turns.cancel`) and keeps the live
  stream open: the terminal `turn.cancelled` event settles this client and
  every other one watching the session. The partial reply is kept in the
  transcript with an explicit "stopped" badge, never disguised as a complete
  answer. On an older daemon the button falls back to the previous
  local-render stop and says exactly that.
- **Steer: interrupt and send now.** Ctrl+Enter (Cmd+Enter on Mac), or press
  and hold the send button on a phone, interrupts the current reply and runs
  your message immediately. Plain Enter still sends normally.
- **Queue-when-busy.** A message sent while a reply is streaming queues
  behind it (the daemon no longer races concurrent turns against one
  conversation) and shows an honest "queued" badge until its turn starts.

### Fixed

- The Stop control is now reachable for the whole active turn: it previously
  required streamed text, so a turn could not be stopped while the model was
  still thinking or inside a long tool call.
- The badges above close two honesty gaps: a queued message used to render as
  "Sent ✓" and a stopped partial rendered unmarked.

## [1.1.1] - 2026-07-07

Test-harness and CI honesty release: no product code changed.

### Fixed

- Two phone end-to-end tests closed the navigation drawer by clicking the
  center of the backdrop, a point the open drawer itself covers; they only
  passed by racing the drawer's opening animation and failed deterministically
  on CI. They now tap the always-visible dimmed area beside the drawer.
- All lint errors: unused test fixture arguments, empty mock function bodies,
  useless variable initializers, and the service worker being excluded from
  linting entirely (it is now linted with service-worker globals).

### Changed

- The end-to-end harness no longer produces refused-connection noise: the two
  direct routes the chat-spec mock missed (`/status`, `/config`) are now
  answered in-page, and the vite proxy's former dead target is a deliberate
  stub that answers anything the in-page mocks structurally cannot intercept
  (requests made under a real service worker in the PWA specs) with an
  unmistakable 503 `E2E_STUB`: a clean run's server log is now silent, so a
  refused connection can never again be mistaken for the suite's normal state.
- The lint and end-to-end CI jobs are now blocking. They previously ran with
  `continue-on-error`, which let the workflow report success while those jobs
  failed: a green checkmark must mean everything is green. Ruling recorded in
  [docs/decisions/2026-07-07-e2e-ci-in-ci.md](docs/decisions/2026-07-07-e2e-ci-in-ci.md).
- Removed a stale duplicate of the 1.1.0 installable-app notes that had been
  left under Unreleased.
- Documentation refreshed to the shipped 1.1.x surface: the README (badges,
  feature surface, verification, release checklist), the operator guide (all
  eleven views plus voice and install), the architecture doc (typed contract
  client, session union, memory/voice/PWA models, multiplexed invalidation),
  the SDK surface matrix (new method families; the `sessions.followUp`
  exclusion narrowed to what it means), known limitations (no longer claims
  gaps that were fixed), security notes (Web Push key custody), the screenshot
  tour, and the pinned Bun version in the development guide. All screenshots
  recaptured from the current UI against the end-to-end suite's seeded mock
  daemon.

## [1.1.0] - 2026-07-07

The desktop release: the web UI becomes a full chat application and operator
console with feature parity across most of the terminal UI's surface, on the
typed `@pellux/goodvibes-sdk` 1.3.1 contracts.

### Added

- **A modern chat app**: streaming markdown with highlighted code blocks and
  copy buttons, a searchable history sidebar, a rich composer with attachments,
  regenerate and edit-with-branching where superseded turns stay viewable
  (never silently gone), automatic conversation titles, and stop-generation.
- **Voice in the browser**: spoken replies (batched, concurrency-capped
  synthesis with quiet retry), microphone dictation over the daemon's
  speech-to-text with review-before-send, and one voice configuration shared
  across terminal, desktop, and agent.
- **Memory view**: browse and search the shared cross-surface memory store
  with the recall-honesty details rendered verbatim (search mode, index
  availability, exclusion counts, the store's recall floor), review-state
  edits, and true deletion.
- **Deeper operator surfaces**: fleet process tree with steer/detach/stop
  where the wire genuinely supports them (honest notes where it doesn't),
  inline approvals from the tree, knowledge consolidation candidates and
  prompt-packet builder with truncation disclosure, a calendar view with ICS
  import/export, a multi-target model workspace, and a settings modal with
  the terminal UI's category naming and secret redaction.
- **Installable app (PWA)**: add-to-home-screen install on iOS/Android, an
  offline shell that opens instantly and says plainly when the daemon is
  unreachable, and push notifications for approvals delivered through the
  daemon's own encrypted push service.
- **Cross-machine serving**: the daemon can serve this app same-origin
  (opt-in), so a browser on another machine reaches it with zero
  cross-origin configuration, designed for `tailscale serve`.

### Fixed

- Live updates now connect only after sign-in and reconnect on every auth
  change; transport errors show friendly wording, never raw server JSON.
- Every view fits a phone viewport with no horizontal scrolling.
- A plain-HTTP address shows an honest "this page needs HTTPS" message
  instead of a blank screen.

## [1.0.1] - 2026-07-06

### Added

- **Cross-surface credential status.** The typed `sdk.operator.credentials.get`
  facade over the daemon's admin-scoped, secret-free credential-status read, plus
  `deriveCredentialAvailability`: a `503 CREDENTIAL_STORE_UNAVAILABLE`, a
  `METHOD_NOT_FOUND` from an older daemon, or any transport failure degrades to an
  honest unavailable state with a plain reason: never a fabricated "configured",
  and never a credential byte in the browser. Completes the cross-surface credential
  status adoption the 1.0.0 notes wrongly listed as deferred.

## [1.0.0] - 2026-07-06

First stable release of the GoodVibes WebUI, the browser surface of the
one-platform ecosystem, running on the typed `@pellux/goodvibes-sdk` 1.0.0
operator contracts. It reaches the same daemon as the TUI and the agent, so a
session, provider, or checkpoint is visible across every surface.

### Milestone arc

- **Sessions union view.** Every surface's sessions in one list, with the
  honest `idle-reaped` badge + tooltip and reopen-on-heartbeat semantics.
- **Fleet, checkpoints, per-hunk approvals, tasks, and workstream views.** The
  operator process tree, checkpoint list/diff/restore, per-hunk approve/reject,
  task lifecycle, and workstream/phase composition rendered from the wire.
- **Chat resilience.** Steer/follow-up over the daemon, capability probes that
  degrade honestly by machine code (not prose) when a method is unavailable, and
  a search surface that says "unavailable" rather than lying.
- **Delete-means-delete.** Companion chat hard-delete wired to the spine
  `sessions.delete` verb; a deleted session never resurrects.
- **Provider pills, knowledge map, browser-history search**, and the
  **mobile steer-from-phone hero** at 390×844 with the hermetic Playwright e2e
  harness (mock daemon; never touches a real port).
- **Typed operator client.** `src/lib/contract-bridge-types.ts` is now sourced
  directly from the 1.0.0 `OperatorMethodInput`/`OperatorMethodOutput` maps
  (the `// SWAP:` seam), so a contract rename fails the `bridge-matches-schema`
  test loudly instead of drifting.

### Changed

- Updated `@pellux/goodvibes-sdk` to `1.0.0` (from `0.38.0`), the 1.0.0
  release-train pin. The operator-method contract families the webui facade
  calls (`fleet.*`, `checkpoints.*`, `sessions.search`) now carry real
  `OperatorMethodInputMap`/`OperatorMethodOutputMap` entries, so
  `src/lib/contract-bridge-types.ts` applies its long-planned `// SWAP:` seam:
  the hand-authored 0.38 bridge interfaces are replaced one-for-one by
  `OperatorMethodInput<M>`/`OperatorMethodOutput<M>`, with `FleetProcessNode`,
  `WorkspaceCheckpoint`, and `SessionsSearchSessionSummary` kept as item-level
  aliases so every consumer import compiles unchanged. The
  `bridge-matches-schema` test now pins the bridge shapes against 1.0.0's real
  `operator-contract.json`; its sample fixtures were updated to the real
  literal-union members (`state: 'executing-tool'`, `costState: 'priced'`,
  `retentionClass: 'standard'`).

### Deferred

- The C1 webui credentials-facade block and provider-status honest-degrade
  rewire is deferred to a follow-up: the SDK C1 credential-status method ships
  in 1.0.0, but the security-sensitive webui adoption is not gate-blocking and
  its verbatim design notes were not persisted, so it is not improvised here.

## [0.2.1] - 2026-06-19

### Fixed

- **CI**: pin `setup-bun` to 1.3.14 to match the locally-verified toolchain:
  1.3.10 produced `window is not defined` in the happy-dom +
  `bun test --isolate` test harness. Coverage step now runs with `--isolate`
  and the coverage annotation guards a missing summary file.
- **Lint**: resolved all ESLint errors across the chat workspace modules
  (dot-notation, array-type, optional-chain, redundant type conversions,
  unused vars, invalid void type, prefer-const, unsafe return) so the lint job
  passes (0 errors / 53 warnings). Intentional render-time derived-state guards
  carry targeted `react-hooks/refs` disables with justification.
- Removed `.github/dependabot.yml` (re-introduced in error during the 0.2.0
  tooling work).

## [0.2.0] - 2026-06-19

### Added

- **Design token system + dark-mode-default foundation.** Full semantic token
  system (`src/styles/tokens.css`) covering color (light/dark via `[data-theme]`),
  spacing, radius, typography, elevation, motion, and z-index. App ships
  dark-first with `prefers-color-scheme` bootstrap and `prefers-reduced-motion`
  support throughout.
- **Density modes.** Compact, default, and comfortable density presets
  persisted in the existing UI-preferences store and applied globally.
- **⌘K command palette + global hotkeys.** Fuzzy-search and invoke any
  registered action from the keyboard. Pre-bound shortcuts for navigation,
  new chat, search, and palette open. Shortcut cheatsheet overlay lists all
  registered bindings.
- **Daemon pulse status strip.** Persistent shell strip showing connection
  state (connected / reconnecting / down), round-trip latency, SSE health, and
  active-work count at all times.
- **Chat workspace overhaul.** Token streaming with stop control; edit /
  regenerate / branch on any message; artifacts slide-over panel for structured
  data blocks and large outputs; cross-session message search; upgraded composer
  with inline model menu, slash-command trigger, drag-and-drop / paste
  attachments, and optimistic send.
- **URL deep-linking + slide-over peek.** Chat sessions, views, and peek
  targets are addressable by URL and survive page refresh; non-blocking
  slide-over overlay for sessions, artifacts, and records.
- **Toast / undo notifications.** Non-blocking toasts with optional undo
  actions and auto-dismiss; purposeful entrance/exit animations.
- **Feedback primitives.** Consistent skeleton loaders, empty-state
  illustrations, and error-state messages with retry actions across all views.
  Top-level `ErrorBoundary` prevents a single component failure from blanking
  the app.
- **Full keyboard accessibility.** Roving focus, visible focus rings,
  `aria-live` announcer, focus-trap for modals/palette/slide-over.
- **Responsive + mobile layout.** Responsive breakpoints from mobile to
  wide-desktop; density and motion preferences stored and applied globally.
- **ESLint + Prettier + jsx-a11y tooling.** Project-wide lint/format
  enforcement with `eslint-plugin-jsx-a11y` for accessibility linting.
- **happy-dom test harness.** DOM-capable unit tests via `happy-dom`.
- **CI caching + coverage.** GitHub Actions workflow gains dependency caching
  and test-coverage reporting.
- **Dependabot.** Automated dependency update PRs for npm and GitHub Actions.
- **537 tests.** Component, unit, and integration tests covering command
  palette, status strip, chat stream, theme/preferences, a11y helpers, and
  per-view logic.

### Changed

- `ChatView` decomposed into focused modules under `src/views/chat/` (Composer,
  MessageList, MessageItem, SessionHeader, and stream/turn hooks) for
  maintainability.
- Shell (`App.tsx` / `main.tsx`) updated to mount `ThemeProvider`,
  `ToastProvider`, `CommandPalette`, `StatusStrip`, top-level `ErrorBoundary`,
  and URL-driven view router.
- KnowledgeView, ProvidersView, and AdminView updated with loading/empty/error
  states, peek integration, and full keyboard/roving-focus accessibility.

## [0.1.39] - 2026-05-20

### Changed

- Updated `@types/react` to `19.2.15`.

## [0.1.38] - 2026-05-19

### Changed

- Updated frontend dependencies to current releases, including Vite 8,
  `@vitejs/plugin-react` 6, `lucide-react` 1, React 19.2.6,
  React Query 5.100.11, and `@types/bun` 1.3.14.

## [0.1.37] - 2026-05-17

### Added

- Added a screenshot tour with real captures from the running WebUI.
- Added known limitations, security notes, and SDK surface matrix docs.
- Added README CI/status badges and embedded screenshot previews.

## [0.1.36] - 2026-05-16

### Added

- Reworked the README into a complete project entrypoint with runtime topology,
  auth, surfaces, verification, and release notes.
- Added architecture, operator guide, development, SDK update checklist, and
  troubleshooting documentation under `docs/`.

## [0.1.35] - 2026-05-11

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.30`.

## [0.1.34] - 2026-05-10

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.26`.

## [0.1.33] - 2026-05-10

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.24`.

## [0.1.32] - 2026-05-10

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.23` for WRFC authoritative request-scope fixes.

## [0.1.31] - 2026-05-09

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.22` for the WRFC owner-chain orchestration contract update.

## [0.1.30] - 2026-05-09

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.21` for shared work-plan APIs and WRFC lifecycle metadata fixes.

## [0.1.29] - 2026-05-09

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.19`.

## [0.1.28] - 2026-05-08

### Fixed

- Render newly sent chat messages immediately with optimistic local state instead of waiting for the next composer update.
- Kept freshly-created chat sessions visible while the daemon session list catches up after session creation.
- Normalized nested companion chat message-list responses so daemon-returned messages render consistently.

## [0.1.27] - 2026-05-08

### Fixed

- Avoided cycling through additional browser-cached chat ids while waiting for the daemon companion session list after a stale session is detected.

## [0.1.26] - 2026-05-08

### Fixed

- Pruned stale browser-cached companion chat sessions after the daemon session list loads, including selected sessions that now return `SESSION_NOT_FOUND`.

## [0.1.25] - 2026-05-08

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.18` for the WRFC owner orchestration additions.

## [0.1.24] - 2026-05-08

### Fixed

- Cleared captured chat composer attachments immediately on submit so slow or stuck attachment sends cannot leave the selected file pinned in the input or wipe newer text typed while the upload is pending.

## [0.1.23] - 2026-05-08

### Added

- Added a sidebar delete action for companion chat sessions, including local cache cleanup and active-session fallback.

## [0.1.22] - 2026-05-08

### Fixed

- Persisted companion chat sessions and the active chat session across page refreshes while still merging daemon-returned session lists when available.

## [0.1.21] - 2026-05-08

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.17` for the physically separated regular Knowledge/Wiki and Home Assistant Home Graph runtime stores.

## [0.1.20] - 2026-05-08

### Added

- Added syntax highlighting for rendered Markdown code blocks with common LLM/code languages.

## [0.1.19] - 2026-05-08

### Added

- Added per-code-block copy buttons to Markdown responses while preserving whole-message copy actions.
- Added an Admin display preference for decorative code-block line numbers.

## [0.1.18] - 2026-05-08

### Removed

- Removed the Dashboard page and its primary navigation item so Chat remains the main surface and secondary controls stay in Knowledge, Providers, and Admin.

## [0.1.17] - 2026-05-08

### Changed

- Made the Vite dev server derive its host and port from the TUI web listener settings, with environment overrides reserved for one-off dev runs.

## [0.1.16] - 2026-05-08

### Changed

- Replaced the Dashboard with a focused operator overview that carries model route, auth, provider, knowledge, task, approval, and session posture.
- Removed the separate Work page from primary navigation and moved its task/approval/session actions into Dashboard.
- Removed the non-clickable runtime badge strip from non-chat page headers.

## [0.1.15] - 2026-05-08

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.16` for the upstream default Knowledge/Wiki scoping fix while keeping WebUI on regular browser knowledge routes with no Home Assistant filters or explicit scope flags.

## [0.1.14] - 2026-05-07

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.11` so regular Knowledge/Wiki routes use the upstream default knowledge-space scoping fix without WebUI-side HomeGraph filtering.

## [0.1.13] - 2026-05-07

### Changed

- Extended the GoodVibes dark/neon visual system across Dashboard, Knowledge, Providers, Work, and Admin instead of leaving those pages on the old light dashboard theme.

## [0.1.12] - 2026-05-07

### Added

- Rendered Markdown/GFM for chat messages, knowledge answers, wiki projection output, and string-valued data blocks.

### Changed

- Switched the app body, chat, navigation, controls, and content areas back to a normal legible sans-serif stack while keeping the GoodVibes sidebar brand treatment.

## [0.1.11] - 2026-05-07

### Fixed

- Added real `/favicon.ico` plus 16px and 32px PNG icon variants so browser tab/favicon UIs can resolve the GoodVibes icon reliably.

## [0.1.10] - 2026-05-07

### Added

- Updated `@pellux/goodvibes-sdk` to `0.33.10` and enabled real companion-chat file attachments through `sdk.artifacts.create` plus `sdk.chat.messages.create` attachment references.

### Fixed

- Resolved subscription-backed provider model lists so runtime providers such as `openai-subscriber` source selectable models from the catalog provider (`openai`) while still using daemon-valid registry keys.
- Applied the same provider/model source resolution on the Providers page and chat composer.

## [0.1.9] - 2026-05-07

### Fixed

- Changed the chat composer provider dropdown to include the daemon provider registry from `/api/providers`, merged with `/api/models` for model filtering.

## [0.1.8] - 2026-05-07

### Fixed

- Centered the GoodVibes brand icon in the collapsed sidebar state.

## [0.1.7] - 2026-05-07

### Changed

- Removed the separate collapse control from the collapsed sidebar state.
- Made the collapsed sidebar rail and GoodVibes icon expand the sidebar, while nav icons continue to navigate without expanding.
- Simplified collapsed active-nav styling so the underline is the only active indicator.

## [0.1.6] - 2026-05-07

### Changed

- Added the `goodvibes.sh` favicon as the browser icon and sidebar brand mark.
- Shortened the sidebar wordmark to `GOODVIBES`.
- Made the sidebar collapse control visible and easier to target in the brand header.
- Removed the grid-line texture from the sidebar background.

## [0.1.5] - 2026-05-07

### Changed

- Restored attachment and voice affordance icons in the chat composer as disabled controls until companion-chat file and voice contracts exist.

## [0.1.4] - 2026-05-07

### Changed

- Reworked the chat theme toward the `goodvibes.sh` terminal/vaporwave direction with neon accents, grid texture, and mono typography.
- Added a collapsible app sidebar and moved browser/control-plane/realtime status from the sidebar into Admin.
- Replaced the duplicate chat-session dropdown with an editable chat title backed by `sdk.chat.sessions.update`.
- Split daemon model selection into provider and model dropdowns, with model choices filtered by the selected provider.
- Kept chat file attachment controls out of the composer because companion chat still has no public attachment contract in SDK `0.33.9`.

### Fixed

- Kept user message bubbles sized to the message text while hover actions render below the bubble.
- Fixed retry actions so user messages resend and assistant responses regenerate from the preceding user message.

## [0.1.3] - 2026-05-07

### Changed

- Updated `@pellux/goodvibes-sdk` to `0.33.9` and switched the chat sidebar to the public `sdk.chat.sessions.list` API.
- Removed the temporary local recent-session workaround used before SDK chat session listing existed.
- Reworked Chat into the primary workspace with chat recents in the app sidebar, a centered conversation canvas, and an integrated composer.
- Added subtle per-message hover actions for copy and resend plus delivery status indicators.
- Kept attachment and voice controls disabled because companion chat has no public attachment or voice contract yet.

## [0.1.2] - 2026-05-07

### Fixed

- Kept companion chat on the daemon's current provider/model instead of sending chat-local route overrides.
- Prevented chat turns from showing `completed` unless assistant content has rendered or synced.
- Removed duplicated session ids, daemon receipts, and provider/model controls from the chat composer.
- Added daemon current-model viewing and selection to the Providers page through `/api/models/current`.
- Showed newly created chat sessions immediately while the SDK lacks companion chat session listing.

## [0.1.1] - 2026-05-07

### Fixed

- Fixed companion chat explicit provider/model routing to use the selected runtime provider row and raw model id.
- Replaced the operator-session chat sidebar with a local recent companion-chat session list backed by `sdk.chat.sessions.get`.
- Rendered submitted chat messages immediately and surfaced companion turn errors as errors instead of misleading accepted receipts.

## [0.1.0] - 2026-05-07

### Added

- Initial Bun, Vite, React, and TypeScript WebUI for the GoodVibes daemon.
- Browser SDK auth flow using daemon login/session auth and token storage.
- Dashboard, provider, work, admin, and base knowledge/wiki operator views.
- Standalone daemon-owned companion chat via `@pellux/goodvibes-sdk@0.33.8` `sdk.chat`.
- Provider-qualified model routing for new companion chat sessions.
- Local and GitHub CI for tests, typecheck, and production build.

### Changed

- Updated GoodVibes SDK dependencies to `0.33.8`.
- Switched WebUI chat away from shared-session follow-up/task semantics.

### Removed

- Removed the shared-session follow-up helper used by the previous chat path.
