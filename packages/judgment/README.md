# @goodvibes-jev/judgment

The level 0 Jev foundation for GoodVibes. Every decision the engine and the products hand to Jev goes through this package: the judgment port that talks to the TypeSafe System One models, the typed readings those models return, named batteries of questions with fixtures and accuracy floors, reusable patterns and compound patterns, the decision log, and live calibration.

## Install

```sh
npm install @goodvibes-jev/judgment
```

`@goodvibes-jev/engine` depends on this package and installs it with the engine.

## Entry points

- `@goodvibes-jev/judgment`: the full foundation. It loads under Node and Bun; the SQLite decision log (`SqliteDecisionLog`) opens its database with `bun:sqlite`, so logging to SQLite runs under Bun.
- `@goodvibes-jev/judgment/decisions`: the runtime-neutral part (batteries, readings, bands and the port's types) with no transport, decision log, Node or Bun module. Code that runs in browsers and Workers imports this subpath.
- `@goodvibes-jev/judgment/testing`: a fake port and answer builders for tests that must not call a model.

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

The decision log keeps every call with what the decision concluded (a `readings` note), what code did with it (an `action` note) and, once known, what was right (a `truth` note). Calibration records each fixture's expectations as truth on that fixture's call; an owner correction or an observed outcome is attached the same way. The engine's observe subsystem reads accuracy against confidence, threshold sweeps, drift and questions stuck in confirm or escalate from the log alone.

## License

MIT

## Explicit endpoint failover

`createSystemOnePort` still accepts the existing single `endpoint`, `model`,
`timeoutMs` and `retry` configuration. Add `fallbacks: [{ endpoint, model }]` to
try other explicitly configured **System One** endpoints in order. Each endpoint
uses the same `POST /v1/systemone` protocol, including owner-run loopback servers.
A chat/completions provider is not a compatible substitute. Redirects are refused.

The transport owns retries, with SDK retries disabled. The default is two extra
attempts per endpoint, capped at ten. It honors bounded Retry-After guidance,
uses capped exponential backoff, and has a `totalTimeoutMs` deadline (120 seconds
by default) across every attempt and delay. Connection failures, timeouts, 408,
429 and 5xx can retry and fail over. Authentication, other 4xx, invalid requests
and invalid responses fail immediately. Cancellation stops retries and failover.
No reading or heuristic answer is returned when the chain is exhausted. Each
request may supply a tighter `totalTimeoutMs`; it cannot extend the configured
deadline. State and questions are snapshotted once so retries cannot evaluate
a mutated payload under the original logical reading.

Failover requires pinned `jev-X.Y.Z` model identifiers, with optional version
suffixes. A fallback is eligible only when its model equals the logical request's
model exactly. A different returned version fails closed because the thresholds
have not been calibrated for it. Moving aliases retain their previous behavior
only in single-endpoint mode. Configuring a different version does not establish
calibration: run the relevant batteries against that version before selecting it.

Results and failures contain `lineage`: one logical request ID and ordered wire
attempts with endpoint index/kind, model, latency, HTTP status, outcome and safe
server request ID. `withDecisionLog` stores this in the one answered/failed entry
for the logical reading. It never records endpoint URLs, credentials, upstream
error bodies or causes as attempt metadata. `port.health()` reports per-target
observed attempts, consecutive failures and last outcome without changing order.

Engine-managed persisted failover settings are a separate integration. Until that integration is enabled, pass the complete explicit chain to `createSystemOnePort`.
