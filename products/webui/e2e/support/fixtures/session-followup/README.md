# Real session follow-up HTTP response captures

The four JSON files are exported by
`packages/engine/test/session-followup-receipts-http.test.ts`. Each `body` is the
unaltered response text from a real ephemeral loopback HTTP listener. Runtime
ids, timestamps, metadata and complete records are preserved. The outer JSON
records the method, path, request body and HTTP status; it is capture metadata,
not an invented daemon response.

The listener runs production `dispatchSessionRoutes`,
`createDaemonRuntimeSessionRouteHandlers` and `SharedSessionBroker`, with a real
temporary persistent store. A real HTTP `sessions.register` request registers a
TUI participant. The agent status boundary always returns null, and an attempted
daemon spawn throws. Authentication, channel bindings and agent execution are
explicit fixture boundaries. This is a real route/broker HTTP test, not an
authenticated full-daemon or live-provider test.

Each run submits `POST /api/sessions/s-tui-idle/follow-up`. The actual 202 response
says `mode: queued-for-surface`, `agentId: null`, and `input.state: queued`.
The same input id is subsequently read through `sessions.inputs.list`:

- completed: HTTP delivery with `consumed:false` gives delivered, then HTTP
  delivery with `consumed:true` gives completed
- failed: HTTP delivery gives delivered, then the real TUI failure boundary
  `SharedSessionBroker.failInput` records the failure; HTTP listing returns failed
- cancelled: the existing input cancellation HTTP route cancels the queued input

`capacity.json` separately captures a surfaceless session whose spawn boundary
returns a scripted 429 `CAPACITY_EXCEEDED` refusal. The real handler returns that
bare error after the real broker has already persisted a queued input, proved by
the following HTTP list. A non-2xx response without an input receipt therefore
does not necessarily prove rejection and must not trigger an automatic retry.
When that fixture's spawn boundary subsequently accepts a second follow-up, the
real broker claims the oldest queued input. The second POST currently says its
new input is spawned, while the authoritative list still says that new input is
queued. Both actual response bodies are retained to justify reconciling an
initial spawned receipt back to queued by input id. This test documents the
existing engine behavior; it does not change the engine's response construction.

The browser loader validates every body against the canonical output schema. The
phone and desktop proofs replay these exact bodies through the production SDK
and composer. Unrelated Work lists remain the ordinary synthetic browser seed.
Read errors and connection loss are explicitly injected failure cases. Polling
uses the real React Query timer, advanced by Playwright's browser clock, without
synthetic lifecycle events or reloads. No browser write drives the delivery,
failure or cancellation transitions; those represent the registered TUI.

## Reproduce

From the repository root with Bun 1.3.14 and the workspace packages prepared:

```sh
GOODVIBES_TEST_SESSION_FOLLOWUP_FIXTURE_DIR="$PWD/.tmp/session-followup-captures" \
  bun packages/engine/scripts/test.ts test/session-followup-receipts-http.test.ts
```

To replace checked-in captures, copy the four exported files unchanged, then run:

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/webui \
  e2e/support/session-followup-fixture.test.ts
cd products/webui
bunx playwright test e2e/session-followup-receipts.e2e.ts \
  --project=phone --project=desktop --workers=1
```
