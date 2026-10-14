# @goodvibes-jev/judgment

The level 0 Jev foundation for GoodVibes. Every decision the engine and the products hand to Jev goes through this package: the judgment port that talks to the TypeSafe System One models, the typed readings those models return, named batteries of questions with fixtures and accuracy floors, reusable patterns and compound patterns, the decision log, and live calibration.

## Install

```sh
npm install @goodvibes-jev/judgment
```

`@goodvibes-jev/engine` depends on this package and installs it with the engine.

## Entry points

- `@goodvibes-jev/judgment`: the full foundation. It loads under Node and Bun; the SQLite decision log (`SqliteDecisionLog`) opens its database with `bun:sqlite`, so logging to SQLite runs under Bun.
- `@goodvibes-jev/judgment/decisions`: the runtime-neutral part (batteries, readings, bands, port types and the autonomous `JevDecision` schema/validation) with no transport, decision log, Node or Bun module. Code that runs in browsers and Workers imports this subpath.
- `@goodvibes-jev/judgment/testing`: a fake port and answer builders for tests that must not call a model.

## Current contract and migration status

The [autonomous Jev decision contract](../../docs/design/autonomous-jev-decisions.md)
is the target for every semantic decision. Consumers use `act`, `revise`, `defer`
or `reject`, with no human runtime approval or escalation. Schema and binding
validation are implemented; they are not a semantic evaluator, authorization
service or atomic execution ledger. Historical band/log outcomes `confirm` and
`escalate` remain readable and must never be converted into `act`.

Primary-only transient outages stay pending through the shared port until
recovery or owner cancellation. With configured fallbacks, the port tries the
compatible chain once and returns typed `unavailable` if every target fails.
Products consume waiting progress and terminal errors without local retry loops.
Permanent request/authentication/format and decision-log failures remain terminal
operational errors. The managed
transport, native runtime disposal and browser/relay cancellation implement this
lifecycle; legacy autonomous consumer migration remains unfinished. See the
[repository status](../../README.md#status) for the open admission and
grant/revocation work. No live-provider proof is established by these interfaces.

## A port and a battery

Answer validation checks probabilities before a result becomes a reading or a
successful log record. Choice requires unit probability mass and a maximum-
probability offered option; Score requires unit mass and a headline equal to the
probability-weighted rubric level within the API’s hundredth rounding intervals.
Fractional scores are valid. Standalone
yes/no, Choice and Score readers apply validation to injected answers as well.
Confidence remains separate from the selected option or score.

```ts
import { createSystemOnePort, judgmentConfigFromEnv } from '@goodvibes-jev/judgment';
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment/decisions';

const port = createSystemOnePort(judgmentConfigFromEnv(process.env));

const battery = defineBattery({
  name: 'example.reply',
  version: 1,
  description: 'Whether a reply answers the question it was asked.',
  accuracyFloor: 0.9,
  items: {
    answers: yesNo('Does this reply answer the question it was asked?', STAKES_BANDS.low.yesNo),
  },
  fixtures: [],
});

const run = await battery.run(port, 'Question: ...\nReply: ...', { site: 'example.reply' });
```

Each check is read for what it actually decides: a check whose answer is its own definition (arithmetic, dates, counting, id equality, a grammar a program produced, a value the owner configured) stays code, and a check that answers a question of meaning is asked of the model, whatever its category, security checks included. Every battery keeps its questions and thresholds in one place, and `bun run calibrate --registry <module>` runs its fixtures live against the configured model (by default `jev-latest`) and fails when a battery falls below its floor.

The decision log keeps every call with what the decision concluded (a `readings` note), what code did with it (an `action` note) and, once known, what was right (a `truth` note). Calibration records each fixture's expectations as truth on that fixture's call; an owner correction or an observed outcome is attached the same way. The engine's observe subsystem reads accuracy against confidence, threshold sweeps, drift and historical questions stuck in `confirm` or `escalate` from the log alone. Those log values do not prescribe human approval in the autonomous contract.

Decision IDs are opaque exact keys, not timestamps or a UUID-format contract.
New SQLite IDs preserve every UUIDv7 hex nibble through a one-to-one a–p
encoding, preventing generated decimal runs from resembling payment-card
material. Existing keys stay untouched and remain readable and attachable;
there is no schema change or privacy-screening exemption. Sort by the entry's
`at` field; equal timestamps have a deterministic ID tie-break, not a promised
cross-format chronology.

Calibration attributes truth only to newly observed, answered calibration rows
whose IDs were returned through that fixture execution's port. It compares the
same newest 100,000-row window before and after, keeping fixture matching and
preferring the named decision's own calls over delegated calls. Custom logs
must retain append-only immutable entries and stable query ordering. Calls
outside the window or without a returned recorded ID receive no fixture truth;
concurrent calls and previously returned IDs are not a fallback source.

## License

MIT

## Explicit endpoint failover

This section describes ordered configured failover, primary-only availability
retries and owned cancellation.

`createSystemOnePort` still accepts the existing single `endpoint`, `model`,
`timeoutMs` and `retry` configuration. Add `fallbacks: [{ endpoint, model }]` to
try other explicitly configured **System One** endpoints in order. Each endpoint
uses the same `POST /v1/systemone` protocol, including owner-run loopback servers.
A chat/completions provider is not a compatible substitute. Redirects are refused.

The transport is the one attempt owner; SDK retries are disabled for judgments.
Connection failures, per-attempt timeouts, HTTP 408, 429 and 5xx allow retry or
failover. With no configured fallbacks, the primary retries until an answer
arrives or the owning signal cancels. That mode has no attempt-count or elapsed
outage ceiling.

With a nonempty fallback list, the port tries the primary and compatible
fallbacks once, in configured order. If every eligible attempt fails, the call
throws `JudgmentError` with kind `unavailable` and its actual attempt lineage.
It does not restart the primary cycle or wait after the final failure.
`withDecisionLog` records one failed entry. Exhaustion provides no semantic answer
or authority to act.

The default capped exponential backoff between attempts starts at 500 ms, caps
at 5 seconds, and applies 25% jitter; every delay is at least 1 ms. Valid
Retry-After or Retry-After-Ms guidance is a minimum wait when another attempt
remains, even when longer than the local cap. Both in-flight attempts and backoff
waits are cancellable, including long waits that must fit the platform timer
range.

Authentication and other non-transient HTTP errors terminate as `rejected`.
Invalid configuration/input terminates as `invalid-request`; malformed response
bodies, answer schemas or model drift terminate as `invalid-response`. A broken
decision log terminates as `unrecorded`. These failures cannot be repaired by
blindly replaying the same judgment and must never become a heuristic reading.
Per-attempt `timeoutMs` is retained. Legacy `retry.maxRetries`, retry opt-outs and
`totalTimeoutMs` are rejected; migrate to timing-only `retry` settings and an
owner-controlled `AbortSignal` for cancellation, shutdown or real authority
expiry. No persisted engine retry-count setting exists to migrate.

State and questions are snapshotted once so retries cannot evaluate a mutated
payload under the original logical reading. `beforeAttempt` is a synchronous,
fail-closed authority check immediately before each wire transmission, including
after backoff. Browser callers use it to revalidate live principal, route, source
and outbound authorization. Callers with asynchronous permission sources may
also supply `beforeAsyncAttempt`; every attempt awaits that admission under the
owning cancellation signal, then runs `beforeAttempt` synchronously before
dispatch. A refused admission sends nothing and is not an availability retry.
The per-attempt timeout starts only after admission; cancellation also stops a
pending admission that ignores its signal. `beforeAttempt` remains synchronous
and rejects promise returns. A progress-only `onRetry` observer receives
`JudgmentRetryProgress` containing the stable logical request ID, immutable last
attempt metadata, elapsed time and next delay. Observer failures are ignored;
progress is neither a semantic result nor authority to act. The retry loop owns
only the judgment request. Provider writes, tools, cursor advancement and other
business effects stay outside it and may run only after the final reading.

Native composition aborts and drains its recorded calls before closing the
log. Awaitable disposal scopes wait for that drain; legacy synchronous scopes
start the owned drain while preserving their synchronous API. Browser calls keep admission/concurrency limits, body-read budgets,
capability expiry/revocation and bounded shutdown; they do not impose a separate
Jev availability deadline. Owned browser references signal expiry/revocation
immediately, including during long provider-directed waits. Custom authority
sources with no invalidation signal are rechecked before every transmission. Caller cancellation or shutdown ends the pending
reading without an answer.

The engine's existing endpoint, key-source, model and attempt-timeout settings
are captured together before asynchronous credential resolution. A settings
edit applies to the next reading; it cannot send an already acquired credential
to a newly selected endpoint. Attempts keep their original configuration and
model until they answer, exhaust the configured chain or their owning lifecycle
cancels them.

Failover requires pinned `jev-X.Y.Z` model identifiers, with optional version
suffixes. A fallback is eligible only when its model equals the logical request's
model exactly. If all configured fallbacks are incompatible, only the primary is
attempted and its retryable failure exhausts the call. A different returned
version fails closed because the thresholds
have not been calibrated for it. Moving aliases retain their previous behavior
only in single-endpoint mode. Configuring a different version does not establish
calibration: run the relevant batteries against that version before selecting it.
The default model is `jev-latest`, TypeSafe's most recent stable release. Batteries
inherit the configured model instead of pinning a release. A fallback is eligible
only when its configured model or alias equals the request's model. Official Jev
aliases may resolve to a versioned Jev response on any target; an explicitly
requested version must match exactly. Decision evidence records both the
requested alias and the resolved response model. Calibration runs against the
same alias and records the versions observed during the run.

Results and failures contain `lineage`: one logical request ID and ordered wire
attempts with endpoint index/kind, model, latency, HTTP status, outcome and safe
server request ID. The most recent 128 attempts are retained; `omittedAttempts`
counts earlier attempts so an indefinite primary-only outage does not grow
memory without bound. Attempt numbers remain absolute within the logical reading. `withDecisionLog` stores this in the one answered/failed entry
for the logical reading. It never records endpoint URLs, credentials, upstream
error bodies or causes as attempt metadata. `port.health()` reports per-target
observed attempts, consecutive failures and last outcome without changing order.

### Recorded-port failure and answer boundary

`withDecisionLog` also validates borrowed ports before recording or returning an
answer. Answers must match the requested question schemas; only documented
answer and metadata fields are retained. `requestedModel` must match the actual
request override or captured port default, while `model` remains the responding
provider's separately validated model identifier. Invalid answers fail with
`JudgmentError.kind === 'invalid-response'` rather than becoming usable readings.

Choice probabilities must admit a unit-mass distribution within their wire
rounding intervals, and the selected option must have the highest probability; ties are
valid. The same validation applies to standalone `readChoice`. This follows the
[TypeSafe Choice response contract](https://docs.typesafe.ai/primitives/choice).
[Confidence is a separate statistic](https://docs.typesafe.ai/confidence), so it
is preserved rather than equated with the selected probability or recomputed.
Malformed distributions are refused, never silently renormalized.

Recorded calls expose a fixed, value-free message for each `JudgmentError.kind`.
Upstream exception text, stack, cause and extra properties are not preserved in
the returned error or decision entry. Diagnose failures through the typed kind,
validated HTTP status/request ID/attempt lineage when available, and the log's
decision/site context; do not match provider error text. Inspect configuration
through the owning setup/settings surface when a provider is unconfigured.
Managed transport cancellation remains `aborted`; the recording wrapper keeps
`unavailable` attribution only for an explicitly timeout-typed owner signal.
No default outage deadline is introduced. A decision-log write failure remains
`unrecorded`. Borrowed/injected ports own their own transport contract;
`withDecisionLog` validates and records them but does not install another retry
loop. Production native, browser and gateway judgment exposures all acquire the
managed System One port. Test doubles may intentionally return terminal failures.

Engine-managed runtimes also read the ordered `judgment.fallbacks` setting.
Each entry supplies an endpoint, pinned model and an environment or secret-store
key reference. The runtime captures the chain with the primary settings before
credential resolution. Direct callers pass the complete explicit chain to
`createSystemOnePort`.
