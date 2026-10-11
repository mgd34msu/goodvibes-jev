# Runtime ownership and verification boundaries

This is a behavioral contract for WebUI implementations and their tests. It is
not an implementation-status report or evidence that a test, live provider,
connected deployment, or release has passed. The engine's current public
contracts and the [autonomous decision contract](../../../docs/design/autonomous-jev-decisions.md)
govern semantic decisions; recorded historical confirmation/escalation outcomes
remain history and must not create a new human semantic approval/reply path.
Explicit cancellation and destructive-action confirmation retain their own
deterministic UI behavior.

## Browser and daemon ownership

Keep the Chat, Work, Library and Personal places, shared shell/settings/UI kit,
responsive list/detail behavior, themes/assets, navigation and existing explicit
controls. Browser theme/sidebar/right-panel state belongs to the browser and is
independent of removed engine runtime panel state. Preserve complete responsive,
pointer and reduced-motion styling. Navigation changes do not remove daemon
methods or the [legacy URL and fragment compatibility contract](architecture.md#navigation-and-the-settings-dialog).

The browser composes typed engine/daemon results. A named judgment battery or an
import does not establish an authenticated, registered, reachable runtime route.
No model-provider client, Jev API key or heuristic semantic fallback belongs in
the browser bundle. Source references cannot select outbound routes or grant
transmission by possession. Current principal, source, scope and client lifetime
must still authorize use; revocation must fence dispatch, hashing, records and
attachments. Adopt only complete current readings and keep shared-port transport
waiting separate from semantic outcomes.

Authentication, same-origin push URL and pairing validation, sanitization/link
safety, format/schema checks, card digit/Luhn/expiry/CVV validation and no-echo
containment, money arithmetic, exact machine codes and closed enum membership
remain deterministic. Use exact matching over closed wire values rather than
tolerant substring matching. The daemon owns credentials, durable data and
completion notifications; preserve stable receipt consume/dedup through
reconnection, sign-out/reattachment and StrictMode.

## Semantic consumers and privacy

Command registration, dispatch callbacks, empty-query order, keyboard/focus
mechanics and selection bounds remain browser code. Nonempty command search
consumes the authenticated command-ranking result, bound to the registry,
canonical chat-title source and current client lifetime. Retire stale answers
after query, selection, dismissal or identity changes. Machine error codes and
security facts remain code; dynamic refusal prose requires its authority-bound
canonical error reference and reading, without substring fallback.

Credential presentation uses metadata only, never credential values. Exact
declared provider-key relationships have a shared engine owner; unknown/custom
alignment must consume its canonical reading rather than provider-name
substrings. Preserve daemon provider facts, exact identity joins, per-route
freshness/current model, and shared model-family/provider-match ownership.

Declared settings-key membership and conservative exclusion/masking are privacy
floors. Unknown-key classification must not expose values or treat an unresolved
reading as safe to render. Canonical key-metadata readings must preserve those
floors; keep card/secret no-echo behavior and substantive secret-key regression
coverage. Schema input parsing, enum membership, typed commits, secret-store
refusals, Advanced reachability, daemon persistence/refusals and card-panel scope
remain meaningful behavior.

Status presentation uses producer-owned catalog identity or exhaustive closed
states (including provider freshness, hunk review and memory review state).
Unknown arbitrary prose is unclassified. Do not reintroduce word-bucket tone
guessing or a browser confidence cutoff for memory review. Review rows join exact
daemon-selected identities; review fixtures supply canonical readings/order.
The explicit prompt recall-floor policy is a separate deterministic boundary.

Registered code grammar names/aliases and HTML escaping remain mechanical;
language inference belongs to its canonical reader. Browser standalone state,
captured install events and installation lifecycle remain authoritative facts;
fallback platform interpretation must not override them. Speech-seam readings
need cancellation and stale-answer ownership, while blank-line/word grammar,
byte/length limits, concurrency, HTTP 429 handling and stop remain deterministic
browser scheduling behavior. This does not require moving that scheduler into
daemon VoiceService. CLI discovery must retain bounded safe failure and settings
fallback instead of inferring supported commands from help prose.

## Mail reply subjects

Only a complete canonical mail read for the current account, mailbox and UID
may issue the opaque subject reference. An acted result keeps the exact subject
or prepends `Re: `; pending or held readings choose no heuristic fallback. Manual
editing remains available. Cancellation, draft identity and client-lifetime
guards retire stale work. Reader/transport fixtures do not establish external
mail delivery or live classification quality.

## Work, sessions and native sources

Work/ContractTree renders canonical goals, criteria/readings, group/unit/attempt
trees, evidence, terminal records and historical escalation with identity-scoped
reads and explicit malformed/failed-refresh behavior. A legacy node review shape
must not substitute for canonical checks. Timestamp quietness is not a semantic
stall-route judgment. Preserve observed, external-agent and watcher rows, graph
ordering/blocked reasons, and their explicit controls. Attempt selection,
`applied=false`/conflict and stale identity are distinct from semantic selection;
historical owner-pick wording does not authorize a new human decision workflow.

Explicit contract cancellation is single-flight and account/detail-intent bound.
An unknown outcome must not replay: obtain fresh list/detail/fleet reads before
a new attempt. Acknowledgement is not child drainage or rollback; `false` may
describe a retained nonterminal record with no live runner, not only an already
ended contract. Keep authenticated HTTP/runner coverage of these distinctions.

Session follow-up preserves input IDs and queued/delivered/completed states,
reconciling through existing events, reads and polling without resending unknown
outcomes. Close/reopen/delete is fenced by originating identity and selection.
Deletion closes first and requires target-specific absence proof beyond the
capped session list. Repeated clicks, cancellation/dismissal, late responses and
identity changes must not act on or close a newer selection.

Unknown/null/zero/non-local context and actual model provenance remain distinct.
Known capacity ceilings, source/origin and accepted-input lower bounds are not
interchangeable with budget or stored usage estimates. Retire stale model reads;
the estimate is not a fresh count or guaranteed multi-loop accounting. Where
cap/floor metadata has no dedicated realtime event, another invalidation or read
must refresh it. Gate-preset labels and settable IDs come from the engine's
browser-safe preset catalog; preserve session-scoped get/set verbs, read-only
custom state and explicit non-local refusal.

Preserve partial approval hunk indices, reasons, modified execution arguments,
remember tiers, push-fragment scrubbing, authoritative outcomes and cancellation
of stale approval refreshes. Checkpoint create/compare/restore retains no-op
creation, preview tokens, structured refusals and destructive confirmation.
Hosted create/list/attach/detach/kill/transcript/stream and CI watch/create/fix
remain route-backed capabilities; renamed screens are not proof of parity.

Native WebUI source admission, execution, hosted delivery and continuation follow
their retained [intake](../../../docs/design/webui-native-intake.md),
[execution](../../../docs/design/webui-native-execution.md),
[hosted-delivery](../../../docs/design/webui-native-hosted-turn.md) and
[continuation](../../../docs/design/webui-native-session-continuation.md) designs.
Keep exact original source, current authority and durable no-replay boundaries.
Source-less `contracts.start`, fabricated revisions, broader scopes, legacy
start/reply and inspection receipts cannot substitute for native admission.
Shared tokens and user sessions do not acquire native-route authority.

## Terminal palette persistence

The canonical `display.theme` schema supplies the 13-choice palette enum and
`goodvibes` default; its public value type remains `string`, while runtime writes
enforce the enum. General settings consumes regenerated engine metadata. The
palette-purpose description and genuine credential-key classification remain
unchanged. Palette ownership is client-local and separate from `display.themeMode`
and browser appearance.

Fresh, unset and reset values use `goodvibes`. Preserve the `vaporwave` alias,
canonical application, preview/cancel/save and left/right enum cycling. Recognized
saved case/whitespace forms normalize only in the read view, without rewriting
files during ingestion. Unrelated key-specific writes preserve saved spelling;
an explicit bulk save serializes the resolved canonical name. Unknown values
retain ordinary quarantine. A presentation reader alone cannot implement a
persisted setting: canonical schema/default, generated metadata, persistence,
credential classification and browser behavior are separate obligations.

The terminal-theme browser fixture uses real config validation and disk-backed
persistence but synthetic authorization, error readings and unrelated routes.
Preserve that boundary when interpreting its results. Its behavior tests are
`packages/engine/test/config-terminal-theme.test.ts`,
`products/webui/e2e/support/terminal-theme-host.ts` and
`products/webui/e2e/terminal-theme-config.e2e.ts`.

## Verification that survives accounting cleanup

Use the [testing and validation runbook](testing-and-validation.md) for actual
commands, isolated runners, engine-derived drift checks, browser-safe production
bundling, packaging and daemon smoke. Retain the required monorepo gates.
Source imports, counts, mappings, fixture geometry, test discovery and build-only
success do not establish runtime, visual, semantic or whole-product acceptance.
Controlled browser fixtures and authenticated loopback HTTP establish their
tested scope, not a deployed account, real provider, live credential/payment or
external-purchase acceptance. Keep genuine semantic calibration separate.

Preserve meaningful interaction tests when retiring old paths: ConfirmDialog
Cancel/Escape/scrim, safe initial focus, focus return and replacement asks;
Dialog/Menu Tab wrap, keyboard handling and nested overlays; PWA/service-worker/
offline behavior; actual touch targets; and rendered design proof of overflow,
padding/clipping and scroll containers. Do not substitute copy/class/schema-size,
source-text, coverage-percentage or description-length quotas. Retiring a
standalone publisher/workflow/lock authority does not retire runtime proof.

Keep focused contract, gate-preset write, nullable/unknown/non-local context,
session-lifecycle, input-receipt and daemon-receipt regressions. In particular,
`e2e/session-lifecycle-identity.e2e.ts`, `e2e/session-followup-receipts.e2e.ts`,
`e2e/daemon-receipts.e2e.ts`, `e2e/session-gate-presets.e2e.ts`,
`e2e/session-context-provenance.e2e.ts` and
`packages/engine/test/contract/cancellation-http.test.ts` preserve distinct
boundaries. A successor-path mapping does not prove case-for-case equivalence;
record concrete missing scenarios rather than treating a rename as passing proof.

## Canonical browser semantic sources

The [authenticated browser judgment transport](../../../docs/contracts/browser-semantic-transport.md)
owns source grants, principal/method identity, route revision, cancellation,
full-input privacy, evidence logging, closed output validation and provider
budgets. Browser callers do not grant permission by possessing a source handle.

PWA fallback consumes `webui.pwa.install-platform`. Native standalone state,
`appinstalled` and captured `beforeinstallprompt` take precedence. Uncertain or
unavailable readings must not manufacture installation instructions.

For untagged or unsupported code fences, `webui.code.language` receives canonical
session/message identity, exact fence offsets and a full-message digest, never
browser-supplied code. The daemon screens the complete original canonical message
before hashing or extracting the block. Unsupported sources, partial/streaming
messages and expired readings stay escaped plaintext. Registered highlight.js
grammars and aliases remain deterministic.

Provider credential highlighting first uses the engine's exact key declarations.
Only unknown/custom stored names reach `webui.credentials.provider-key`, with
canonical inventory and admin authority rechecked. No credential value is
available to the reader; provider-name substrings cannot decide alignment.

Settings use `SECRET_BEARING_CONFIG_PATHS`. Unknown rows start masked, including
numeric and object values. `webui.config.credential-key` reuses
`config.credential-key@2` with canonical names/descriptions only. Only a current,
explicit acted negative may clear an unknown row. Held, failed, malformed or late
answers cannot. Declared secret paths remain masked even when their values are
malformed objects. Configuration incarnation and client/query lifetime revoke
pending decisions. This classification grants no config read/write authority.

Vite discovery consumes the daemon's versioned `--help --json` capability catalog
and only its declared read-only status JSON invocation. Status inspection must
not initialize settings, migrate files, start a runtime or acquire credentials.
Settings/terminal fallbacks remain bounded and refuse malformed, oversized or
hung output rather than parsing help prose.

Memory-review fixtures use explicit canonical `needs_review` probabilities and
retain every candidate before ranking/limiting. Missing or invalid readings fail
closed even for candidates beyond the requested limit. The prompt recall floor
is an independent policy, unchanged by these fixtures.

## Mail provenance and overlay ownership

The settled reply-subject value is only `alreadyReply: boolean`; use the exact
captured subject or add `Re: ` locally. Canonical provenance requires the actual
requested UID, a complete unique nonpartial subject header, mailbox identity and
positive UIDVALIDITY. Private result-object maps hold the observed snapshot.
Config/credential changes, source replacement, expiry, cancellation and shutdown
retire its authority. The lease proves an immutable observed read, not current
remote existence or sending permission. Ambiguous, protected or unbound messages
remain viewable with manual subject editing. Draft fields and explicit send
confirmation remain independently owned.

The composer uses the shared body-level overlay plane, focus lifecycle and Escape
registration, so pointer actions reach fields, Close and Save. Initial focus is
mount-stable; only explicit Compose/Reply actions may refocus an existing panel.
Confirmation is a subsequent layer; closing restores the opener. Repeated Reply
must preserve keyboard ownership without changing shared Drawer policy or
remounting the draft. Cancellation, direct replacement, late responses,
account/host changes and draft identity remain separate stale-work boundaries.

## Public consumer and meaningful validation boundaries

Session gate presets preserve engine-owned labels/order, known/unknown/absent
presentation, settable IDs and custom rejection, session-local writes
and refreshed selection, custom read-only state, nonlocal refusal, pending/error
states and dismissal/navigation behavior. Keep actual engine get/set round trips
and refused custom, unknown, empty and prototype values. The full fresh-authorization
inventory must include `email.inbox.read` and compare every marked operator
method; adding a protected route is not a reason to narrow the security guard.
Optional mail source hooks and the closed mail battery remain additive public
interfaces; preserve existing exports. Generated operator-contract method objects must match their canonical engine
schemas, preserving unrelated methods, order, metadata, events and serializer.

Validate actual pointer clicks and focus, not just visibility or `fill`: reachable
phone close/reopen controls, desktop repeated Reply, focus restoration, Tab wrap,
late-result focus stability, Escape ordering and explicit confirmation before
synthetic send. Retain account/host, draft identity, replacement, cancellation
and late-response tests. Execute semantic browser cases over the production app
for provider names/highlighting, stale provider selection, native install-state
precedence and memory-review transport. React DOM or synthetic-port success does
not substitute for browser execution or genuine live calibration.

Native work-ledger intake requires persisted paired-admin authority and the
`read:work-ledger`/`write:work-ledger` scopes. Inspection receipts do not confer
those capabilities or execution authority. Authenticated native source admission
is distinct from source-less `contracts.start`, which native runners reject.

Keep event-domain invalidation checked against the public runtime-domain type:
approval-related filters use the canonical gate domain, not a retired permissions
domain. Preserve known, null, absent, zero and explicit `SESSION_NOT_LOCAL`
context cases, schema-owned enum rendering/selection, and stable-ID receipt
consumption under StrictMode and sign-out/reattachment. A persisted presentation
setting requires its actual canonical schema/default, generated metadata,
persistence, credential classification and browser behavior; a local display
helper or unrelated settings reconciliation is insufficient.
