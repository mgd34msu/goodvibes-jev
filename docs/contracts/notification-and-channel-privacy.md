# Notification, channel delivery and check-in privacy

## Channel delivery diagnostics

The shared HTTP logger and channel delivery router publish structural diagnostics
without copying known delivery credentials, destination capabilities or private
provider failure text. This boundary does not establish application-wide privacy coverage.

### HTTP publication

`instrumentedFetch` retains the actual URL, body, headers, response and rejection.
Its optional `opaque-url` diagnostic mode is selected by the owner of a capability
URL. Telegram, BlueBubbles, Slack response URLs, Discord webhooks/interactions,
Google Chat and generic public webhooks use it. Generic webhook DNS refusal logs
also withhold the destination and borrowed resolver detail; the existing DNS
checks, address pinning, Host header and TLS behavior remain intact.

Default URL diagnostics omit userinfo, fragments and all query names and values.
They additionally redact fixed credential slots in Telegram, Slack and Discord
protocol URLs. These are structural protocol positions, not a classifier for
arbitrary sensitive text. Unknown capability URLs require the owning caller to
select opaque mode. HTTP method diagnostics use a closed set and contain getter
failures. Logger failures cannot turn a completed delivery into another attempt.

### Router publication and receipts

Router failure logs contain only closed surface/strategy/target-kind values and
the existing validated HTTP status projection. They omit raw target addresses,
binding identifiers, error messages and causes. The exact original rejection is
still returned privately to the caller for the existing semantic retry decision;
it is not a safe public error and must not be serialized by a downstream owner.

Known webhook/response URLs and Discord application-plus-interaction-token
fallbacks are no longer returned as message IDs. These successful sends return
the already-supported absent ID. Ordinary provider message IDs remain available.
This does not attest arbitrary provider-supplied IDs as safe for publication.

### Validation and scope

Owned synthetic tests execute the real strategies and router through a mocked
final fetch boundary, then inspect an actual ActivityLogger file. They verify
unchanged requests and useful status/method diagnostics, raw and encoded provider
credentials, query names/values, response echoes, hostile getters, logger errors,
private rejection identity, ordinary message IDs and both public-webhook pinning
branches. A private-DNS refusal makes zero transport calls and retains its
original private failure while publishing only fixed diagnostics.

No real provider credentials or accounts are used. No global source-classification
or retry policy is replaced. Other publication owners, including
AutomationDeliveryManager's attempt records/events and original error formatting,
require their own bounded handling before public exposure; these boundaries do not
establish application-wide log, receipt or privacy coverage.

## Typed proactive check-in decision

The runtime asks the canonical `engine.checkin.worth-interrupting` yes/no battery over the complete captured briefing. Only a settled high-band yes can continue. No or uncertain stays silent; a missing/unrecorded/permanently failing port produces an error receipt. Temporary provider failure remains pending in the shared Jev transport until recovery or owner cancellation, without a check-in retry loop.

### Note content and evidence

The foundation does not generate prose ([judgment capabilities](../audit/judgment-capabilities.md)). As with the existing knowledge-answer architecture, a separate ordinary provider drafts content only after the typed yes. The canonical `engine.checkin.note-fidelity` pattern verifies the exact draft against the same captured briefing. Supported high-band fidelity is required; unsupported, contradicted, uncertain, missing or unavailable verification never sends. No chat response is parsed to decide contact. Both recorded decision IDs and typed readings are retained in the check-in receipt; the generation mechanism is not presented as native Jev generation.

### Lifetime and delivery

Configuration remains off by default. Existing destination, cadence, quiet hours, gateway scopes and delivery policy are retained. Evaluation is bound to the real ConfigManager pre-mutation invalidation hook, so disable/re-enable cannot revive a pending decision. Scheduled evaluations also capture the current job revision, including its enabled state and source ownership. Disabling, removing or changing that job fences pending work, and terminal bookkeeping preserves the current job rather than restoring a captured record. The caller’s signal, current invocation authority, runtime disposal and exact config are checked around waits and before delivery. The delivery contract carries that same lifetime through credential/attachment preparation and underlying network preparation; a guarded send requires a strategy implementing this contract. Unsupported custom strategies and legacy agent senders fail closed for guarded requests. Ordinary callers without a lifetime keep their existing behavior.

The accepted-send boundary is the transport invocation after its final guard. Cancellation or revocation before that boundary prevents sending; cancellation after an accepted send does not undo it or erase a confirmed receipt. Once delivery has been entered, a thrown or interrupted response produces an unconfirmed-delivery error rather than a skipped/cancelled claim; delivery entry means invoking the deliverer, so this deliberately also covers pre-send preparation failures without claiming a send occurred; this conservatively covers transports that may have sent before their response was lost. If a confirmed send is followed by receipt-persistence failure, the returned delivered outcome retains its known delivery ID and carries a receipt-persistence warning in its summary/error diagnostics, so automated failure handling cannot turn it into a resend; neither sending nor appending is blindly retried. Custom strategies explicitly advertising guarded-delivery support are responsible for honoring the contract in their own code.

### Validation limits

Synthetic typed readings and transports establish wiring, provenance, protected-input and cancellation behavior, not model accuracy. Battery calibration is separate from structural source tests. These tests require no live provider, account credential, check-in activation or third-party contact.

## Notification delivery privacy

### Public producer contract

`NotificationDelivery` is a readonly union of `kind: turn | approval | budget`
and the corresponding typed `facts`. The upstream turn/name/approval/budget
fact and builder signatures are retained. `Notifier.notifyNotification` returns
`Promise<void>`; `WebhookNotifier.sendNotification` returns the existing
`Promise<WebhookNotifierSendResult>`. Both constructors and `fromConfig`
factories accept a live `metadataOnly?: () => unknown` callback.

Only literal false permits content. Missing, malformed, throwing or asynchronous
callbacks require restricted output; rejected async results are consumed without
logging their private errors or authorizing a later false result. No schema,
ConfigKey, persisted default, write control or credential-gate bypass is added.
Existing hosts without this callback become restrictive. Hosts must wire the callback at their actual delivery boundaries, including
desktop and terminal producers.

### Ownership and attempt boundary

Admission explicitly copies only the typed fact fields into frozen snapshots.
No caller object or renderer closure is retained. Restricted admission does not
read private content fields. Every recipient, retry and dead-letter replay of
one notification shares one internally owned envelope. A restrictive live check
replaces the snapshot with a redacted one and increments its revision exactly
once. Later permission cannot resurrect discarded fields.

Every actual outbound attempt renders after its live check. For webhooks,
asynchronous HMAC signing is followed by another live check and an envelope
revision comparison. A change discards the old body/signature pair; the one
possible downgrade permits at most one re-render/re-sign. The sent signature
always covers the actual body. A recipient that observes restriction therefore
also protects another recipient still signing and all subsequent retries.

Restricted builders use only outcomes, finite numeric facts and closed
code-owned subject/tool/category identifiers. Unknown identifiers use generic
wording. Arbitrary session IDs are omitted: an opaque-looking string is not
generated-ID provenance. Names, reasons, paths, commands and turn names are
never inferred from legacy strings. The upstream English dangling-word list
and reason-word comparison are not imported; display trimming uses mechanical
whitespace/word-boundary limits only.

### Queue compatibility and diagnostics

`DeliveryQueue<TPayload = string>` and `DeadLetterEntry<TPayload = string>`
preserve existing string callers and every retry/failure-reading/close/replay
state transition. The notifier uses the same queue with its owned envelope.
The queue has no disk-persistence API: typed in-memory payloads keep their owner
through replay. An envelope serializes only its restricted string projection,
so the existing JSON string-payload shape remains available without rich facts.
Old string rows have no admission provenance and replay only a fixed generic
notice. Public notifier queue status retains string payloads and never exposes
the rich descriptor. Known runtime event IDs remain tracing labels; arbitrary
legacy event wording is replaced with a fixed notification identifier because
queue IDs and diagnostics can outlive a privacy change.

Legacy `notify(event, data)` and `send(text)` remain accepted. Explicitly
permissive admission preserves their text; restrictive admission or a later
restriction uses the fixed generic notice. A legacy formatter is evaluated
synchronously only when admission permits content and is never queued.
The fixed webhook connectivity probe carries no caller data.

### Notification diagnostics

A response or transport failure may echo a previously permitted private body.
Webhook receipts/logs therefore use a validated HTTP status and fixed summary,
never arbitrary response/transport text; non-success bodies are cancelled rather
than retained. Known suppression/SSRF/privacy failures are typed internal policy
errors with fixed code-owned messages, preserving their useful distinctions.
Recognition and fallback also guard hostile rejection prototype/field accessors.

Notifier opts its queue into structural diagnostics. The queue still passes the
original error to the same failure-transience/Jev decision at the same site,
but validates the returned class/basis against the closed protocol before
retaining or logging evidence. It omits free-form detail and stores only status,
class/basis and value-free summaries. If the reading is unavailable, the
exposed AggregateError contains safe replacement errors and no original cause
or error object. Retry-timer/listener diagnostics use the same projection.
Unrelated queues retain their existing detailed mode by default. A completed
transport also refreshes its envelope, so a restriction observed on response
prevents later recipients/replays from recovering rich fields.

Direct public builders also validate required outcomes/costs/durations, read
numeric activity and approval identifier properties once, retain only those
captured primitives, and contain malformed getter failures in a
value-free error. Thus desktop/terminal consumers get the same structural
privacy boundary rather than relying only on the outbound envelope.

### Delivery validation

Tests exercise actual SDK Slack/Discord/webhook request construction with
the final global fetch boundary intercepted, real Web Crypto signing checked
independently with HMAC, live factories, caller mutation, private getters,
cross-recipient downgrade, retry, DLQ replay, safe serialized string shape,
legacy rows, malformed/async callbacks, direct-builder negative cases and real
response-echo/log/DLQ/unavailable-reading regressions. Adjacent tests preserve SSRF/test
suppression, feature flags, contract event delivery, failure readings and
settled queue/notifier shutdown behavior.

Validation must include hostile approval getters, response echoes and error proxies, as well as unchanged upstream compatibility cases. Generated API review, normal build/type/API gates, independent review and exact-head CI remain required; focused source tests alone do not establish complete product adoption or persisted-setting behavior.

## Live notification privacy reader

`@goodvibes-jev/engine/sdk/platform/runtime/operations` exports
`readNotificationsMetadataOnly` and `NOTIFICATIONS_METADATA_ONLY_KEY`, reusing
its existing `ConfigGet` type.

### Fail-closed contract

Every call reads `behavior.notificationsMetadataOnly` once, live. Only literal
boolean `false` permits content-bearing notification text. Boolean `true`, a
missing key, malformed values (including `"false"` and `0`), and a throwing
getter all require metadata-only output. Read errors are not logged or echoed;
they may contain private persisted values. There is no cached snapshot.
Async and thenable callback results remain non-authorizing even if they resolve
to false. Their rejection is consumed through an owned promise without making
the reader asynchronous or emitting failure details.

An unavailable schema key can make ConfigManager return undefined; section
recovery can also reduce a malformed behavior section to defaults. Neither a
permissive boolean parser nor an absent/invalid-to-false fallback is safe here.
Neither condition establishes permission to disclose notification contents.
Once a separately reviewed schema installs a validated false default, its
resolved boolean is compatible with this reader.

### Host and configuration boundary

The helper is a decision input for host notification producers, not a redactor
or a privacy feature by itself. Hosts must read it at each delivery and actually
omit turn names, reasons, commands and paths when it returns true. The reader
does not install UI controls, schema defaults, a ConfigKey member, setting writes,
credential classification or gate exceptions. Each notification channel must
independently enforce the output restriction at its delivery boundary.

### Reader validation

Focused tests cover exact key and one read per call, live changes, strict
boolean handling, throwing older readers, private read errors, and real
ConfigManager loads/reloads from synthetic files. They prove that missing keys,
malformed preferences and malformed sections remain restrictive without changing
the input files. Schema
adoption must reconcile absent-key assertions with the separate persisted-value refusal
policy rather than silently making an invalid restriction permissive.
An owned, timeout-bounded Bun subprocess additionally proves that immediately
and later rejected promises, throwing thenables and then-accessor failures do
not leak private errors or fail the process; eventual false resolutions never
authorize content.

Schema adoption must preserve the exact privacy-key ingestion refusal and
credential-key reading requirements. The reader neither replaces nor weakens
those checks. Its literal boolean comparison is structural policy, not a
semantic reading or keyword heuristic.

## Focused checks

From the repository root, use the existing workspace-lock-owning test wrapper:

```sh
bun packages/engine/scripts/test.ts test/channel-delivery-diagnostic-boundary.test.ts \
  test/channel-internal-diagnostics-never-delivered.test.ts \
  test/checkin-judgment.test.ts test/checkin-composed.test.ts \
  test/checkin-job-lifetime.test.ts test/checkin-delivery-receipt.test.ts \
  test/notification-delivery-privacy.test.ts test/notification-privacy-reader.test.ts
```

These checks use controlled inputs and intercepted transports; they do not
replace normal release checks or real battery calibration.
