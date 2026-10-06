# Native selected-hunk comment recordings

`lifecycle.json` is emitted by
`products/daemon/src/test/runtime/native-selected-diff-http.test.ts` using the real
paired daemon, checkpoint manager, native intake, dispatch journal, hosted runtime
and shared execution owner. Native outcome response bodies are unchanged
`Response.text()` bytes. The test uses owned judgment controls and a loopback model;
this is orchestration evidence, not live-provider semantic calibration.

The browser loader validates every recorded method, request, successful response
and source identity against the generated operator contract and SDK schemas. It
checks generic-invoke request envelopes against their exact serialized bytes. It
independently hashes the full exact unified diff, checks the host-written
`nativeRevision`, and verifies the host-selected full hunk. All
native project, session, checkpoint, intake, broker and execution identities come
from that daemon run. Native successes are never constructed by the browser mock.
The daemon test also reads hosted attachment history internally to assert the
completed transcript. That unused attachment response is not exported or replayed:
the existing `sessions.hosted.attach` response contains `session.originSurface`,
which its current strict output schema does not declare. This proof does not claim
that unrelated attachment schema is aligned. Exact completed history remains in
the schema-validated native intake continuation, and no replayed response is
modified or exempted from validation.

The native navigation row comes from the real `sessions.list` response and is
cross-checked against the stable identity fields of the real `sessions.get`
response (heartbeat timestamps may advance between reads), with its actual
`kind: "hosted"` retained. This proves the native session is reachable through the
shared Session Changes detail. Only its display title, the unrelated second row,
Fleet navigation node and surrounding shell state are synthetic. Those cosmetic
navigation fixtures do not supply native ownership or fabricate a runtime; the
recorded native-owner lookup remains authoritative.

The Playwright suite exercises real DOM controls, browser history and IndexedDB on
phone and desktop. It checks source separation beyond the old 40-line excerpt,
work versus turn delivery, repeated identical originals, duplicate Submit, exact
queued cancellation and selected-hunk FIFO completion, cancellation while capture is pending, Close and Escape,
lost acknowledgement, read-only Inspect/reopening/reload, stale source refusal,
connection invalidation, hunk/session isolation, discovery failure, cross-surface
Sessions/Fleet inspection, Work New exclusion and explicit legacy preservation. A
separate API-absence case disables browser `crypto.subtle`; this proves the
host-written revision path does not depend on Web Crypto, without claiming an
actual LAN-origin run. Every
native flow rejects legacy execution writes. A dropped or delayed acknowledgement
is a browser transport fault injection; it does not fabricate a host result.

Screenshots accompany visible full-source tail, exact original and provenance
facts. Assertions establish behavior and exact bytes; screenshots do not substitute
for execution. Loader/typecheck/discovery success is separate from a completed
Chromium run. Local Chromium is blocked in the restricted executor; the official
CI browser job executes the production WebUI build.

Regeneration and validation (repository root, engine/contracts rebuilt first):

```sh
GOODVIBES_TEST_NATIVE_SELECTED_DIFF_FIXTURE_DIR="$PWD/products/webui/e2e/support/fixtures/native-selected-diff" \
  bun packages/engine/scripts/test.ts --cwd "$PWD/products/daemon" \
  src/test/runtime/native-selected-diff-http.test.ts
bun packages/engine/scripts/test.ts --cwd "$PWD/products/webui" \
  e2e/support/native-selected-diff-fixture.test.ts
cd products/webui
bunx playwright test native-selected-diff.e2e.ts --project=phone --project=desktop
```
