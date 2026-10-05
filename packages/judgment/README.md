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

Transient outages stay pending through one shared port-owned retry
implementation until recovery, with backoff and responsive lifecycle
cancellation. Products consume waiting progress, not a terminal outage decision,
and must not wrap the port in local retry loops. Permanent request/authentication/
format and decision-log failures remain terminal operational errors. The managed
transport, native runtime disposal and browser/relay cancellation implement this
lifecycle; legacy autonomous consumer migration remains unfinished. See the
[repository status](../../README.md#status) for the open admission and
grant/revocation work. No live-provider proof is established by these interfaces.

## A port and a battery

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

Each check is read for what it actually decides: a check whose answer is its own definition (arithmetic, dates, counting, id equality, a grammar a program produced, a value the owner configured) stays code, and a check that answers a question of meaning is asked of the model, whatever its category, security checks included. Every battery keeps its questions and thresholds in one place, and `bun run calibrate --registry <module>` runs its fixtures live against the pinned model and fails when a battery falls below its floor.

The decision log keeps every call with what the decision concluded (a `readings` note), what code did with it (an `action` note) and, once known, what was right (a `truth` note). Calibration records each fixture's expectations as truth on that fixture's call; an owner correction or an observed outcome is attached the same way. The engine's observe subsystem reads accuracy against confidence, threshold sweeps, drift and historical questions stuck in `confirm` or `escalate` from the log alone. Those log values do not prescribe human approval in the autonomous contract.

## License

MIT

## Explicit endpoint failover

This section describes the shared retry-until-available transport and its owned
cancellation lifecycle.

`createSystemOnePort` still accepts the existing single `endpoint`, `model`,
`timeoutMs` and `retry` configuration. Add `fallbacks: [{ endpoint, model }]` to
try other explicitly configured **System One** endpoints in order. Each endpoint
uses the same `POST /v1/systemone` protocol, including owner-run loopback servers.
A chat/completions provider is not a compatible substitute. Redirects are refused.

The transport is the one retry owner; SDK retries are disabled for judgments.
Connection failures, per-attempt timeouts, HTTP 408, 429 and 5xx stay pending and
retry until an answer arrives or the owning signal cancels. Each round visits
eligible configured endpoints in order. There is no attempt-count or total-time
outage ceiling. The default capped exponential backoff starts at 500 ms, caps at
5 seconds, and applies 25% jitter; every delay is at least 1 ms. Valid Retry-After
or Retry-After-Ms guidance is a minimum wait, even when longer than the local cap.
Both in-flight attempts and backoff waits are cancellable, including long waits
that must be split to fit the platform timer range.

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
and outbound authorization. A progress-only `onRetry` observer receives
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
to a newly selected endpoint. Pending retries keep their original configuration
and model until they answer or their owning lifecycle cancels them.

Failover requires pinned `jev-X.Y.Z` model identifiers, with optional version
suffixes. A fallback is eligible only when its model equals the logical request's
model exactly. A different returned version fails closed because the thresholds
have not been calibrated for it. Moving aliases retain their previous behavior
only in single-endpoint mode. Configuring a different version does not establish
calibration: run the relevant batteries against that version before selecting it.

Results and failures contain `lineage`: one logical request ID and ordered wire
attempts with endpoint index/kind, model, latency, HTTP status, outcome and safe
server request ID. The most recent 128 attempts are retained; `omittedAttempts`
counts earlier attempts so an indefinite outage does not grow memory without
bound. Attempt numbers remain absolute within the logical reading. `withDecisionLog` stores this in the one answered/failed entry
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

Choice probabilities must sum to one (allowing only floating-point addition
roundoff), and the selected option must have the highest probability; ties are
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

Engine-managed persisted failover settings are a separate integration. Until that integration is enabled, pass the complete explicit chain to `createSystemOnePort`.
