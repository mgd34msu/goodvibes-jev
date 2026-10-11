# TUI runtime consumer contracts

These contracts describe product boundaries for canonical engine readers,
operator displays and terminal input. See [architecture](architecture.md) for
composition and [testing and validation](testing-and-validation.md) for the
owned runner, compiler, package and compiled-terminal gates. Synthetic caller
fixtures establish plumbing and lifetime behavior, not live semantic calibration
or service acceptance.

## Changes comments and confirmation ownership

The public Changes modal and `/review` attach and submit comments through the
modal host. Completing or cancelling text entry returns `null` so a callback
cannot clear composition only for its caller to restore the old draft. Comment
attachment and submission remain two distinct Enter operations; this also
prevents a shared commit composer from repeating a completed confirmation.
The retired private DiffReviewPanel and its send-all binding are not recreated.

Validate actual tokens through SurfaceModalHost: c/text/Enter attaches,
second Enter closes then submits, rapid text cannot navigate while composing,
repeated Enter cannot duplicate, Escape cancels one level, close/reopen preserves
one pending attachment, re-edit replaces a hunk comment, blank drafts do not send,
missing submitInput preserves unsent comments, and preview remains read-only.
The shared commit composer must be tested with a cancelled confirmation, so no Git
mutation occurs. Include actual stacked confirmation ownership.

Retain `src/test/views/diff-review.test.ts` for parsing, ranges/counts/excerpts
and steering-template assertions, and
`src/test/input/changes-comment-interaction.test.ts` for actual modal-host
attach/send, structured context, batched unsent comments, duplicate suppression
and source provenance. Source rendering follows the canonical selected-source
label; submitted steering text preserves the exact loaded label, with the
canonical fallback when empty.

## Canonical eval state

The engine observe subsystem owns latest suite/gate results, running state,
last-run time and subscription notifications. Suite-name equality is exact
identity bookkeeping, without a judgment or lexical fallback.

### Composition

- The old TUI view path is a compatibility re-export of public
  `@goodvibes-jev/engine/sdk/platform/observe` / `EvalRegistry`, with no local
  implementation or subclass.
- Command context and `/eval` handler types use that public owner directly.
- Production `createBootstrapCommandExtensionsSection` constructs one canonical
  registry per command context. The registry survives across commands within its context;
  another context receives independent state.
- Engine implementation, exports, public signatures and browser boundaries are
  unchanged. No provider, configuration, mail or scoring behavior is changed.

### Validation

`products/tui/src/test/input/eval-command.test.ts` exercises the real composition
factory and real built-in eval runner, without mocking modules or calling live
providers. Validate constructor identity, per-context isolation, retained state
consumed by the next command, replace-versus-append for suite and gate results,
injectable last-run time, running transitions, notification counts,
unsubscription, baseline persistence and comparison. Existing flag parsing
checks remain. Fixture-based built-in scenarios prove integration, not live
provider performance or broad TUI acceptance.

Canonical owner and runner coverage remains in
`packages/engine/test/observe-hoists.test.ts`,
`packages/engine/test/runtime-eval-runner.test.ts` and
`packages/engine/test/platform-eval-smoke.test.ts`.

## File picker and Gist export

### Canonical owners and callers

- `engine.walk.skip-directory` is registered in the engine judgment registry.
  `utils/directory-reading.ts` owns its question, band, fixtures and level fan-out.
  Public `readWalkDirectories` returns true (skip), false (keep) or null (held).
  TUI `input/file-picker.ts` calls that public owner for actual visible directory
  entries with exact names and relative paths. Hidden-dot filtering, file type,
  depth/count limits and literal partial-path ranking remain code. Ordinary
  files named `dist` or `node_modules` must not be treated as directories.
- Existing `engine.tools.credential-header` ownership is retained. Public
  `tools/credential-header-reading.ts` wraps that same battery; both the existing
  cross-origin redirect caller and TUI Gist resolver adopt it. No duplicate
  credential battery or retry owner is introduced. Only names enter judgment;
  configured values remain local, captured without invoking getters. Standard
  Bearer auth and GITHUB_TOKEN remain explicit authority. The first acting yes
  wins in original header order; held readings cannot select a credential.
- Both readers screen complete supplied names/identities with the existing
  `snapshotJudgmentInput` boundary before projection and port access. Structured
  credential/card names, inline protected material and accessor directory input
  are rejected without a request or input-bearing diagnostic.

### Lifetime and recovery

The picker aborts pending work on Close, invalidation and reopening. A captured
root/current-owner assertion guards traversal, each judgment transport attempt
and completion; old-root traversal cannot continue into another level or publish
a cache. Only complete successful readings populate the cache. Held/failed
readings render an explicit unavailable message, and reopening retries. The
original fuzzy-path ranking and selection/insert/inject semantics remain intact.

Gist uses a separate instance of the existing `ScheduleReadingLifetime` owner
pattern, wired beside scheduling to Escape, new input, session recovery changes
and shell shutdown. It fences the actual reader and final fetch, suppresses a
repeated pending submission, captures export content before async work, and
revalidates conversation generation, session and exact configured auth before
upload. A changed credential requires resubmission. An operational reading
failure preserves the local export and gives a value-free error. Per-attempt
atomic owner-only receipts preserve accepted URLs or unconfirmed dispatches under
the original session even after UI cancellation. A receipt durability failure
retains the accepted/unconfirmed outcome in explicitly source-labelled global
notification history, without mutating a replacement conversation. Cancellation
while fetch is already dispatched does not establish that GitHub received
nothing; no rollback or remote cancellation guarantee is claimed.

### Validation

- Engine `test/directory-credential-readers.test.ts`: canonical fixtures,
  acting/held results, complete-name privacy floor and descriptor-safe capture.
- Existing engine `test/fetch-page-reading.test.ts`: protocol/tool-auth drop,
  nonstandard credential drop and acting noncredential cross-origin retention.
- TUI `src/test/input/file-picker-reading.test.ts`: level fan-out, exact paths,
  authored dist, literal hidden policy, normal files with conventional names,
  failed/held recovery, cache, close/invalidate/root/reopen and retry fencing.
- TUI `src/test/renderer/file-picker-overlay.test.ts`: original rendered picker
  cases plus explicit unavailable rendering rather than endless loading.
- TUI `src/test/export/gist-credential-reading.test.ts` and existing
  `share-e20.test.ts`: exact-value/header-order behavior, protected names,
  mutable/accessor capture, cancellation and standard auth/env/upload behavior.
- TUI `src/test/input/share-credential-reading.test.ts`: real `/share` command,
  pending Escape/session/exit/history/auth changes, repeated submissions,
  zero stale uploads, failure-preserved local export and successful retry.

The TUI reader does not change general engine `walkDir`/find policy. Controlled
ports and fake fetch validate wiring, cancellation and receipt handling; genuine
configured calibration and real Gist/service acceptance require separate checks.

## Memory consolidation receipts

### Owner and live caller

- `packages/engine/sdk/src/platform/knowledge/consolidation-gateway.ts` owns the
  receipt result/proposal/gateway types, unavailable connection branch, typed
  `memory.consolidation.receipts` invocation, and SDK-error 404/501 versus other
  failure classification. The existing public knowledge subpath exports it.
- `products/tui/src/views/memory-consolidation-gateway.ts` only adapts the
  product's trusted operator connection and existing error wording. It does not
  select the receipt verb or classifies statuses.
- `builtin-modals.ts` still supplies a fresh gateway factory on each Memory
  modal fetch. `memory-modal.ts` consumes the canonical types and classifier
  through this adapter. The adapter must not introduce another behavior owner.
- Daemon receipt/proposal production, credentials, connection selection, rendering,
  and stale-result/closed-view handling are unchanged. Classification is a protocol
  fact, rather than semantic judgment.

### Validation

The engine tests use the real SDK's typed route and response validation, preserve
a nonempty retained run receipt (including merged/archived/decayed metadata), check
all three proposal kinds, preserve injected error descriptions, and distinguish
SDK 404/501 from 401/403/500, network errors, and status-shaped ordinary objects.
The product integration exercises synthetic loopback HTTP through the production
adapter into the actual Memory modal: disabled then enabled on refresh, an actual
nonempty retained receipt and pending proposal payload, 404 unavailable, 401 error,
then genuinely empty pending proposals while the historical receipt remains.
An observing wrapper records the unmodified real gateway result delivered to the
modal and asserts the entire receipt/proposal payload. The modal renders the
current pending proposal's reason and record ID; it does not render receipt history.
A retained receipt's historical `proposed` entries must not repopulate the empty
current proposal list. Existing modal
fixtures preserve 501 behavior, proposal jump/correlation, compact rendering, and
obsolete/closed fetch protections. No live account or production credential is used.

Run the engine-owned wrapper against `test/memory-consolidation-gateway.test.ts`
and the product's `src/test/views/memory-consolidation-gateway.test.ts` and
`src/test/views/modals/memory-modal.test.ts`. Keep product source/test types,
engine test types with SDK ambient declarations, and actual workspace checks.
Serialize compiler work through the shared lock with a bounded 4096 MiB heap.

## Provider health and route presentation

`/accounts` already uses the engine's credential-backed provider-account
registry, but that registry has a different route vocabulary and responsibility.
It does not replace generic provider-declared `secret-ref`, `anonymous`, or
`none` descriptors and their repair hints. `/health` covers many individual
findings, but its MCP lifecycle report does not replace the eight-domain typed
summary or the security snapshot's `allow-all`/quarantine findings.

### Canonical ownership and composition

- `packages/engine/sdk/src/platform/runtime/ui/provider-health/domains.ts` owns
  all eight typed domain summaries. Maintenance still delegates to the existing
  engine evaluator. All posture decisions use typed flags, counts and reported
  states; provider prose is only displayed.
- `packages/engine/sdk/src/platform/runtime/ui/provider-health/routes.ts` owns
  original descriptor normalization, fixed route priority, configured/usable
  selection, freshness, issues and repair hints. It does not change actual
  runtime route selection or the credential-backed account registry.
- The declared public `sdk/platform/runtime/provider-health` export is pure and
  browser-safe. Types are imported without loading runtime services, config
  managers, provider implementations or credential stores.
- The two retained TUI helper paths are compatibility re-exports, with no local
  algorithm owner.
- `registerBuiltinModals` calls `createBuiltinProviderHealthModalSurface`, which
  composes the existing real runtime inspection query and live read models.
  Existing Health/Accounts provider rows and Enter repair dispatch remain.
  Routes and Domains are read-only tabs carrying canonical detail. The Routes
  tab is deliberately separate from the selectable repair list: mixing long
  informational blocks with selectable provider rows made trailing details
  unreachable. Existing host line wrapping/scrolling is reused.

### Unavailable and stale data

1. Unknown maintenance context is `info`, retaining the explicit unavailable
   summary, rather than a fabricated `good` level.
2. `providers/runtime-snapshot.ts` must not fabricate `auth.mode = none` when
   runtime metadata is absent or null. The console labels absence unavailable; a provider's
   explicit declaration of no-auth still stays healthy. Models/usage fallback
   data and declared auth semantics are unchanged.
3. A failed inspection refresh identifies retained cached data as last-known.
   Refresh generations discard superseded results and work from a closed modal.
   Automatic ticks coalesce pending reads so slow metadata still publishes.
   Missing domain input reports unavailable rather than fabricating healthy
   counts.

### Validation

Exercise all eight domains in order, trust/quarantine, maintenance
unknown/failure/pressure, descriptor synthesis, route priority, usable versus
configured routes, repair hints, absent auth and the actual runtime-snapshot
typed call. Bundle a consumer of the public provider-health name and execute its
emitted functions; a successful build alone does not prove browser execution.
Retain fallback-chain coverage.

Use the real builtin factory, runtime inspection composition and ConfigModal
renderer for missing/null metadata, explicit none/unconfigured, unavailable
domains, stale refresh, overlapping refresh/close/reopen generations and slow
automatic polling. Drive the keyboard dispatcher at widths 30, 18 and 60,
reach the final wrapped hint after resize, and close through Escape. Retain
provider/settings modal, ConfigModal live-update and repair-command-row tests.

Build actual engine declarations and validate the public subpath API snapshot,
provider-health browser bundle budget, API extraction and aggregate consumer
source/test types. These are required checks, not an execution receipt.

## Provider setup labels

### Scope and authority

The former product `providers/provider-classification.ts` is a thin re-export of
an engine-owned asynchronous provider setup reader. The six known labels and
honest Unknown remain available. This result is presentation only. It does not
select, authorize or veto fallback, change catalog tiers, resolve credentials,
claim readiness, establish actual prices or authorize payment. The existing
`ProviderAccessReadings` and `routing.catalog-provider-access` remain unchanged.
Jev settles semantic setup meaning; there is no new human-question workflow.

### Complete class vocabulary

| Battery question | Result | Required meaning |
| --- | --- | --- |
| `api_key` | `api-key` / API key | Direct provider API key or equivalent secret, excluding cloud-account, gateway, local-runtime and subscription setup |
| `cloud_account` | `cloud-account` / Cloud account | Account-scoped resource credentials, profiles or workload identity, even when runtime auth mode is API key or anonymous |
| `local_runtime` | `local` / Local/no-key | Models actually execute locally without a paid provider API key; a local proxy address is insufficient |
| `no_key_free` | `no-key-free` / No-key/free | Explicitly declared free hosted access without a paid key/account/subscription |
| `self_hosted` | `self-hosted` / Self-hosted | Operator-managed gateway or serving endpoint; upstream billing remains independent |
| `subscription` | `subscription` / Subscription | Stored subscription/OAuth session or plan/seat access; service OAuth alone is insufficient |
| none, multiple, uncertain, unavailable, cancelled or stale | `unknown` / Unknown | Facts do not support one settled class |

The owner preserves exact runtime auth enum values and booleans as facts; it
never substitutes vendor-ID membership. Model count, readiness, anonymous auth
and zero listed prices cannot independently establish free access. Existing
provider definitions remain authoritative for their declared runtime behavior.

### Evidence provenance and privacy

The public `ProviderRuntimeMetadata.setup` addition contains an optional declared
description and endpoint origin. Generic OpenAI/Anthropic-compatible adapters
retain their owner/operator setup description independently of whether a key is
configured. Their endpoint evidence is `URL.origin` only; userinfo, path, query
and fragment are discarded before it reaches either public runtime metadata or
Jev. Unknown/invalid endpoint syntax is absent. No API-key values or resolved
secrets are collected by this seam.

- Generic/discovered providers carry the actual configured origin and scanner's
  server-type provenance, without deriving a setup class from that type or ID.
- Existing SGLang/LiteLLM/Copilot Proxy declarations supply their operator-managed
  setup detail even with a configured key.
- The actual Foundry builtin factory forwards its declared Azure cloud-account
  resource setup. Bedrock, Mantle and Vertex already publish credential-chain,
  cloud account and workload-identity details through runtime auth routes/notes.
- OpenAI Codex already declares its subscription session. Local adapters declare
  locality; local and remote Ollama publish different actual auth/locality facts.
- Synthetic is a multi-backend router, not a local inference engine. It
  declares mixed upstream setup explicitly; no common setup is invented. Its
  routing/dispatch implementation is unchanged.

All supplied setup-relevant fields are captured into one immutable serialized
fact state: identity, setup declaration/origin, exact auth mode/configuration,
auth route state/detail, locality/policy notes, usage cost/notes and runtime
notes. A cache entry is keyed by the complete captured state and battery
version. Only a settled single-class result is cached, not unknown or failed
readings. New facts remove an old entry; newer reads and explicit runtime
invalidation prevent old in-flight results from populating the cache.

### Asynchronous lifetime and callers

`ProviderSetupReadings.read` has an AbortSignal and a bounded default 1500 ms
presentation deadline. Both cancellation and deadline abort the judgment wire
and resolve Unknown, even for a non-cooperative reader. A late answer cannot
cache or deliver a result. A caller can invalidate the runtime-scoped cache
when its config/auth generation is replaced. One-shot CLI reads do not persist
shared state. Models list deduplicates reads per provider within that command.

Actual provider list/inspect, model current/list and support-bundle export await
the public owner over their public runtime snapshots. They retain the original
output fields and disposal behavior. Missing or unavailable setup is Unknown.

Failover preparation joins the existing notice owner's single ordered queue
and total deadline. The synchronous failover hold is acquired before either
reading. A successful error reading survives a setup timeout. The preparation
reads only current from/candidate facts, before registry mutation; actual
optimizer selection, native admission and retry fences remain the existing
ones. Unread/currently different candidates receive Unknown. Provider reload /
credential-refresh events invalidate setup narration. Captured instance identities
are checked after each read, after all preparation finishes, and synchronously at
notice delivery, including a notice queued behind an earlier read. A replaced
instance loses its old label even before its change event arrives. A missing
instance lookup or missing object is Unknown, not a valid identity proof. The
“billing class changed” assertion appears only for two known, different classes;
Unknown on either side retains both labels without claiming a proven change. The notice is handed to retry
rollback once. No independent post-retry async suffix can repaint a newer turn,
session or closed terminal. Runtime setup changes invalidate presentation only;
they are not a newly invented routing admission policy.

### Validation

- `packages/engine/test/providers-setup.test.ts`: all classes, conflicting and
  uncertain readings, absent/free-looking facts, cache fingerprint mutation,
  old-result ownership, cancellation/deadline and credential-free origins;
  actual generic/builtin/discovered/cloud/Ollama/synthetic declaration paths.
- `packages/engine/test/routing/catalog-access.test.ts`: unchanged routing owner.
- `products/tui/src/test/cli/provider-classification.test.ts`: retained public
  vocabulary through the shared owner, no ID-only fallback.
- `products/tui/src/test/cli/provider-setup-facts.test.ts`: gateway, remote Ollama and anonymous-with-models
  classification boundaries.
- `products/tui/src/test/cli/provider-setup-callers.test.ts`: actual CLI dispatch,
  public runtime snapshots and support-bundle serialization in an isolated child;
  only runtime service construction/service posture is substituted. It proves
  awaited results, provider read deduplication and disposal, not full runtime or
  compiled-terminal qualification.
- `products/tui/src/test/core/provider-setup-owner-adoption.test.ts`: actual
  failover caller preparation, ordered lifetime, deadline/Unknown, late result
  silence, cancellation/new turn/session/disposal, provider generation/instance
  replacement and preservation of existing dispatch behavior.
- Existing `format-user-error`, `user-error-owner-adoption`, `failover-wiring`,
  turn-notice and retry suites remain the inherited lifecycle contracts.

Controlled readings do not establish live calibration, billing facts or compiled
terminal behavior. Check product source/test types, fresh owned engine
declarations, engine test and public-consumer types, API extraction, canonical
SDK preparation/subpath regeneration and documentation consistency. Canonical
preparation includes authored ambient declarations and browser assets; compiler
emit alone does not create those files. Additive API regeneration must retain
other public exports rather than overwriting them with an older snapshot.

## Natural-language scheduling

### Owner and supported shapes

`@goodvibes-jev/engine/sdk/platform/automation::readNaturalLanguageSchedule`
owns semantic reading. One batched Jev port call reads the complete phrase,
source epoch clock, IANA timezone, exact literal-quantity candidates and their
UTF-16 offsets. The existing foundation date-parts pattern supplies the approach:
closed choices with unknown and qualification of every consumed part. There is
no English phrase, weekday or unit dictionary acting as a semantic fallback.

The former product `schedule-nl.ts` and its offline-parser-only tests are replaced
by engine and actual registered-command tests. Preserved families are hourly,
daily, weekly, weekdays, weekends, one named weekday, fixed N/unit intervals,
singular-unit intervals, relative N/unit delays, and a bare next time of day.
The old reader supported numeric literal quantities, plus implicit one for a
singular unit. It did not support spelled-out multi-unit amounts, arbitrary
calendar dates, compound intervals or phrase-selected timezone overrides. These
remain explicitly unsupported rather than approximated. Jev can recognize
paraphrases within the supported shapes and read spoken time-of-day parts.

Literal token scanning only offers candidates. Jev assigns their semantic role;
code does not decide that the first number is an amount. The complete-reading
question rejects negation, conflicting quantities, invalid times and any ignored
qualifier. Below-threshold or partial readings create no job. The registered
`automation.schedule` fixtures are discoverable through the existing calibration
registry walker. Scripted tests are plumbing evidence, not a live calibration pass.

The existing cron/every/at normalizers own grammar and ranges. Code assembles
positive safe durations and valid dates; one-shot next-time resolution uses the
scheduler's actual source-zone calendar, including DST gap/fold behavior. The
separate scheduler correction replaces process-local month/day/hour skipping
only when an explicit timezone is present. Its base/minute steps also use epoch
arithmetic so a process-local DST fold cannot rewind a requested-zone scan.
The finite 366-day bound and cron
field grammar are unchanged. Missing wall times use the next real occurrence;
a repeated wall time uses the first occurrence strictly after the captured clock.

### Command and cancellation

Both terminal dispatchers use existing `shellSplit` only for schedule/sched,
with a narrow incomplete/empty-quote guard. Empty words cannot shift prompt
text into the schedule slot. Invalid replacement submissions revoke an older
pending read. Other command tokenization is unchanged.
The owner phrase reaches Jev with internal whitespace and escaped quotes intact.
Typed cron/every/at never calls Jev.

Main owns `ScheduleReadingLifetime`. It captures the session, clock and local
zone before startup awaits, aborts on actual Escape/Ctrl+C, existing session
replacement callbacks, new ordinary input, superseding schedule submissions and
shutdown. Startup rejections follow that same ownership fence; live operational
errors remain visible. Identical pending submissions share one admitted operation. Each
pre-effect await is followed by a live check; the final check immediately
precedes `manager.createJob`. Once that existing manager operation has entered,
this read owner does not pretend it can roll back persistence. Late completion
cannot repaint a cancelled/closed session. One-shot times that expired while Jev
was unavailable create no job.

The shared judgment port alone retries transport outages. There is no product
retry loop or human semantic approval prompt. Missing/permanently failed Jev
reports an operational error; unknown/unsupported/unqualified results create
zero jobs. A later valid invocation can recover. The concrete schedule echoed
before dispatch is the same object passed to createJob; timestamps use ISO UTC
and cron output includes the actual timezone and stagger.

### Validation

- `packages/engine/test/automation-schedule-timezone.test.ts`: zone/calendar cases and isolated process-timezone controls for DST-fold monotonicity and cross-zone scan termination. Existing schedule tests are retained.
- `packages/engine/test/automation-schedule-reading.test.ts`: supported shapes,
  exact arithmetic/provenance, unqualified parts, unknown, ranges, source clock,
  zone rollover, DST gap/fold and calibration discovery.
- `products/tui/src/test/input/schedule-reading.test.ts`: registered command,
  exact createJob payload/echo, actual terminal callers, typed grammar, malformed
  quotes, duplicates, lifecycle cancellation and the real shared retry port
  through controlled 503/recovery and signal-ignoring transport fixtures.

Source/test types, API-surface generation, full-suite gates and compiled product
validation apply to the composed source. Natural-language reading does not
itself grant autonomous job-execution admission.

## Native workstream start

Owner-terminal `/workstream start <request>` enters the same
`NativeConversationIntakeControls` flow as ordinary input. Historical legacy
command controls keep their separate identity and scope.

### Exact source and authority

- Both normal command-mode Enter and the desynchronized slash fallback retain the
  original terminal line before trim, tokenization, or expansion.
- The registry's private one-dispatch WeakMap stores the original line alongside
  the command identity. Public context properties are not authority.
- Command syntax is leading whitespace, `/workstream`, intervening whitespace,
  `start`, and one whitespace separator. A CRLF pair is one separator. The
  complete remaining request is unchanged, including extra leading/trailing
  whitespace, duplicate text, combining characters, emoji and line breaks.
- `captureNativeConversationInput` declares file/context references and folded
  paste/image markers. Derived expansion cannot become owner source.
- Generic execution and copied contexts lose the capability; model contexts
  cannot receive it. A private asynchronous dispatch scope also prevents a nested
  handler from reminting it through the reserved terminal entrypoint, even after
  copying the context. The mark expires after dispatch completes.
- The command does not reconstruct a request from argument tokens or invent
  authority from `invokedByModel: false`. Empty input is rejected locally.

### Routing and recovery

The command uses `routeNativeConversationInput`; no second evaluator or routing
policy is introduced. Jev's native result remains decisive. A work result uses
the existing durable execution-intent and exact native-target path. Only a
permit-bearing, freshly claimed turn result may enter ordinary dispatch.

Missing intake/dispatch bindings fail closed before submission. Existing controls
retain their source/journal bounds, verified principal, host/workspace identity,
single-flight admission, compare-and-swap publication, uncertain-write recovery,
cancellation and late-result fences. The command never falls back to
`contractOperator.start`, an unpermitted ordinary turn, or an alternative runner.

Native intake recovery remains `/work intake-status`, `intake-retry`,
`intake-resume` and `intake-cancel`. Native execution controls remain `/work`.
Historical `/workstream list`, `status`, `cancel` and `reply` preserve their
existing session-scoped legacy IDs and semantics. They do not control new native
work.

### Validation

`workstream-native-intake.test.ts` drives actual terminal handlers through the
registry into native intake controls. It covers both entrypaths, exact text,
source references, native work execution, source-less/model/forged/nested calls,
missing bindings, duplicate pending input, cancellation/late admission, host
replacement, principal-isolated recovery, uncertain capture/journal publication,
and intentionally repeated input. Existing historical command tests retain
list/status/cancel/reply assertions. Shared native intake fixtures keep the
existing recovery suite unchanged.

The existing compiled-terminal artifact-provenance CI lane also exercises the
actual `/workstream start` command in `host-pair-interactive.e2e.test.ts`. An
isolated real daemon verifies paired authority and captures the exact command
request. The proxy loses only the successful capture acknowledgement; the TUI
reports uncertainty, retains the original journal and refuses a replacement.
A separate unpaired-host case refuses without capture. Both fixtures assert zero
legacy model requests and no unexpected mutations or external network access.
The production binary is not given a test-only command or routing branch.

## Runtime composition and compatibility displays

Runtime composition uses the public client contract runner, contract intake and
operator services. Agent orchestration preserves actual contract hooks, approval
handlers and permission-manager ownership. The conversation prompt awaits the
public conversation-audience tier reader with the turn signal. Runtime snapshots
project the current session's recorded contracts; the client owns judgment.

Legacy recorded-contract views preserve real groups, units, attempts, criteria,
checks, nudges and owner questions. Session/fleet cancellation and replies use
the owning runner. They must not invent native execution authority from legacy
planning state. Preserve public ledger actor/revision/receipt semantics and the
separate native intake controls described above; no destructive legacy-data
migration follows from displaying history.

Typed tool outcomes retain cancellation; unrecognized legacy outcomes remain
neutral. Failed or skipped commit notes remain visible at 80 columns in collapsed
lanes and folded turns. Owner/group/unit rollups are excluded from leaf usage
totals. Late contract updates invalidate inactive views. Glyph selection uses
the public read-only reader, not an undeclared configuration key.

Fleet details render `ProcessCheckSummary` criteria, verdicts, reading bands,
correction counts and severity. They do not interpret a retired score/checklist
field or invent old work-item conflict paths. Preserve actual workspace and
application notes. A failed application has warning presentation in closed beads
and folded lanes while the recorded lifecycle can remain `passed`; a skipped
commit remains a separate application status. Preserve actual footer eligibility,
ACP receipt labels and unavailable cost rather than inferring completion or zero
cost from absent data.

Local sandbox commands retain public SDK review, profiles, presets, bundles and
session operations. Retired QEMU provisioning invocations explain retirement
without provisioning or writes. Permission provenance names the actual SDK
read-secrets decision site. Status, doctor and onboarding explanations use public
preset facts, retain broad automatic-approval warnings, and label all public
decision-source variants without inventing an ordered policy walk. Validate
critical ASK, boundary ASK under autoApprove, and actual override ALLOW through
the real gate rather than substituting presentation facts for policy.

Catalog, hook and tool-verification commands await their declared SDK readers.
Managed settings await staging before apply/success; support bundles await both
redaction reads. Marketplace review stays outside rendering, disables actions
while loading, forwards cancellation and discards superseded responses. Memory
review uses `MemoryAccess.reviewQueue(24)` in server order instead of reranking
locally; failed current refreshes clear current content and late generations
cannot replace it.

## Host-owned notification settings

`behavior.notificationsMetadataOnly` belongs to the host, not the shared engine
schema. TUI-owned ConfigManager construction registers an immutable,
restrictive-default descriptor. Consumers use its public typed registered-host
boolean handle and instance schema, preserving normal toggle/reset and public
managed-lock authority. Metadata-only true and explicit details-consent false
have distinct help text. This does not introduce dynamic managed-lock authoring.

Refresh row value/source/lock metadata after writes and through the public
subscription, including an already-open search row after revocation. Preserve
close/reopen listener ownership, descriptor isolation, cross-host-key
notifications, restrictive failed-load/project-write handling and project
fallback. A failed read must not retain details consent. Notification enforcement
and shared defaults remain their canonical owners.

Compiled-shell validation exercises `/config behavior.notificationsMetadataOnly`:
show the host row, persist explicit false with Enter, revoke to true with another
Enter, dismiss, and exit normally. Use actual typed delivery and real polling
watcher deletion/invalid/malformed revocation controls. Inspect renderer frames
at 80x24 and 120x40 independently; synthetic frames are not live screenshots.

## Private workspace and validation boundaries

A private source checkout's launcher and `/update` return local build guidance
before host/config reads and never silently fetch an upstream binary. Build and
smoke invoke the CLI declared by the installed engine package, including
scripts-disabled installs. Postinstall recognizes the exact private workspace
contract and declared root layout while retaining standalone checksum/download
cleanup behavior. Native addon resolution validates exact names, pinned target
versions and payload containment, avoids ancestor shadowing, and stages the
owned addon. Keep actual native sqlite-vec load and vector behavior checks.

Parser grammar loading must await memoized initialization. Controlled
initialization tests verify the complete existing rendered frame without timing
sleeps or gratuitous golden changes. Standard artifact smoke remains mandatory;
a startup success does not waive eager namespace/initialization safety. Any
constructor-call exception requires emitted synchronous initializer dominance,
exported-function ownership and unchanged bindings/initializers. Ordinary aliases
and replaced initializers remain negative controls.

The public toolchain test-runner package includes its entire child/preload/runtime
closure and declarations. An offline normalized tarball must support safe Node
import, actual Bun invocation and guard activation; caught forbidden I/O still
fails the child. Preserve owned POSIX teardown, bounded output drain and explicit
truncation failures, per-file earlier shared/declared deadlines, queue continuation
after a file failure, cancellation shutdown and scratch containment. The shared
720-second invocation ceiling is per file, not a product-queue timer. Direct
product commands require externally held canonical workspace ownership when
qualification can overlap. Windows binary compilation does not establish Windows
source-runner child-tree cleanup. See [runner details](testing-and-validation.md).

Runtime/CLI fixtures seed exact benchmark, catalog, model-limit and gateway-price
cache envelopes under isolated homes when metadata behavior is outside scope;
they must not broadly intercept fetch or weaken the external-network guard.
Synthetic metadata responses match only their explicitly selected requests.
Synthetic payment-key fixtures await public redaction, retain non-reading, CVV,
reference and address assertions, and reject unknown synthetic keys/questions.
Restore the judgment port after each fixture. Permission presentation fixtures
carry explicit public risk-family facts and a generic unread control; they do
not change classification or policy. Generated command references and operator
artifacts must come from the current engine metadata rather than an older build.
Use real launcher/PTY frame, help, dismissal and exit checks, private package
inspection and staged native addon loading. Source, render, compiled-shell,
connected-daemon, first-turn, platform and live-provider evidence are separate
validation boundaries. A cancelled or timed-out file cannot be counted as a
passing aggregate, and historical run totals are not release correctness gates.
