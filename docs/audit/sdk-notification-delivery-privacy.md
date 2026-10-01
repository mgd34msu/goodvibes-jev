# Live notification privacy at delivery

Source target: SDK `17eae838461a6529135fe2cad41332d2dc46cb27`, including its
`runtime/turn-notification.ts` producer facts and shared text builders.
Integration base: current main `9852548e7a81930222d89ee0704c13c1f0d2c74d`, after repaired PR45 and PR48 admission cancellation.
The reviewed reader is now inherited from main; no copied prerequisite repair
remains in this delivery diff. Reviewed implementation/test bytes are unchanged;
the inventory composes with main's nullable-context additions.

## Public producer contract

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
Existing hosts without this callback become restrictive. Host consumer wiring
is still required, including desktop and terminal delivery boundaries.

## Ownership and attempt boundary

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

## Queue compatibility and diagnostics

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

## Notification diagnostics

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

## Evidence and remaining gates

The local guarded run passes 170 tests / 663 assertions across nine suites.
New tests exercise actual SDK Slack/Discord/webhook request construction with
the final global fetch boundary intercepted, real Web Crypto signing checked
independently with HMAC, live factories, caller mutation, private getters,
cross-recipient downgrade, retry, DLQ replay, safe serialized string shape,
legacy rows, malformed/async callbacks, direct-builder negative cases and real
response-echo/log/DLQ/unavailable-reading regressions. Adjacent tests preserve SSRF/test
suppression, feature flags, contract event delivery, failure readings and
settled queue/notifier shutdown behavior.

Independent source review is clear: the reviewer ran 171 tests / 665 assertions
including its approval-getter probe, plus 13 unchanged upstream compatibility
cases / 39 assertions. A separate queue/signing/diagnostics review reproduced
and verified the repaired response-echo and hostile-error-proxy boundaries.
Generated API review, full normal build/type/API gates, reciprocal review and
exact-head CI remain required. Product adoption and the separately gated
persisted setting are not claimed complete by this slice.
