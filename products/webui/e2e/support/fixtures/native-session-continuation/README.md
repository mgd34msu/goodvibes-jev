# Native session continuation recordings

`lifecycle.json` is emitted by the paired daemon integration test at
`products/daemon/src/test/runtime/native-session-continuation-http.test.ts`.
The daemon, native intake owner, dispatch journal, shared broker, hosted runtime,
and Orchestrator are real. Semantic decisions use the owned judgment test port;
model completions come from an owned loopback OpenAI-compatible streaming server.
No external provider or production account is contacted.

Every recorded native response `body` is the original `Response.text()` and is
replayed unchanged. All native source, project, session, broker, and correlation
identities originated in that test run. The fixture loader checks request inputs
and response outputs against both the generated operator contract and SDK schemas.

The second model request evidence contains the original user/assistant message
objects selected from the actual provider request. Unrelated system/tool definitions
are omitted. The integration test checks the full request before recording it.
Hosted attachments are actual daemon method results. Only browser navigation labels
and unrelated shell state are synthetic.

From the repository root, after rebuilding the engine and generated contracts:

```sh
GOODVIBES_TEST_NATIVE_CONTINUATION_FIXTURE_DIR="$PWD/products/webui/e2e/support/fixtures/native-session-continuation" \
  bun packages/engine/scripts/test.ts --cwd "$PWD/products/daemon" \
  src/test/runtime/native-session-continuation-http.test.ts
bun packages/engine/scripts/test.ts --cwd "$PWD/products/webui" \
  e2e/support/native-session-continuation-fixture.test.ts
```

The Playwright suite runs against the production UI bundle. It covers repeated
exact originals, duplicate clicks, interrupted starts, New request, session switches,
lost acknowledgement, read-only reload/Inspect, FIFO queue completion, exact queued
and running cancellation, and native-owner discovery refusal on phone and desktop.
Browser execution is a separate proof from HTTP/fixture validation.
