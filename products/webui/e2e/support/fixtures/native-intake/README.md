# Native conversation intake HTTP captures

These JSON files are exported by
`products/daemon/src/test/runtime/native-intake-http-capture.test.ts`, using the
reusable owned fixture in `products/daemon/src/test/helpers/native-intake-http-fixture.ts`.
Every `body` is the unmodified `Response.text()` received from an ephemeral
loopback listener. The outer object records capture metadata, method, path,
status and request body. Source IDs, revisions, project IDs, decision IDs and
receipt contents are not rewritten. No token or session cookie is retained.

The fixture runs production `DaemonServer`, its complete runtime graph,
authentication, method catalog and HTTP route dispatch, workspace registration,
native intake host, durable source store, Jev decision recorder and work-ledger
publication. The proposer is an owned synthetic provider that selects the whole
input. Jev readings are scripted through the real decision log. Provider/model
discovery and benchmark refresh are disabled. This proves transport, ownership
and lifecycle composition, not live semantic calibration or execution.

The input includes leading/trailing whitespace, Unicode and repeated
requirements. It uses LF, as HTML textareas do. The adjacent daemon
`native-conversation-intake.test.ts` additionally covers original CRLF input.
Every browser transition must match the captured input ID and source revision;
the replay helper never rewrites a receipt to accommodate a different input.

- `work.json`: capture performs no generation; admit publishes one exact-source
  version-2 work receipt; get, repeated capture, resume and late cancellation
  return the same admission. No agent or legacy contract is started.
- `turn.json`: recorded converse routing preserves the full input and never
  invokes the proposer or dispatches a model turn.
- `blocked.json`: the explicit referenced file remains an unsupported-source
  hold. Get, repeated capture and resume cannot erase it or reroll admission.
- `refused.json`: recorded semantic refusal is retained without fresh readings.
- `cancelled.json`: get sees processing/pending while the proposer is held.
  Cancellation records its tombstone, aborts the provider, and waits for real
  cleanup before acknowledging. The old admission fails; get and resume remain
  cancelled and no work is published.
- `recovery.json`: the first proposer call throws. The actual 503 is retained.
  Get and repeated admit report processing/recovery-required without another
  proposal. Only explicit resume obtains a new generation and produces work.
- `auth-denied.json`: anonymous and invalid bearer tokens get 401; shared tokens
  and authenticated user sessions get 403. Each of the five methods is rejected
  when either required ledger scope is absent. Scope reduction is an explicit
  fixture boundary on catalog grants; the HTTP authorization gate is real.
  Client-supplied source metadata, criteria and authority fields are rejected.

Each outcome includes the actual paired-token auth snapshot and project lookup.
The current auth snapshot labels a paired token `authMode: session`; its
`principalKind: token`, `pairing:` principal ID, admin flag and scopes identify
the native owner. Browser permission checks must not invent a `paired-token`
auth mode.

The Playwright helper overlays only auth, project and native intake. Unrelated
Work state remains the existing synthetic mock. Held, disconnected, malformed,
server-error and authority-loss responses are clearly injected browser failures.
The helper seeds request and input IDs through `crypto.randomUUID` so exact
source-bound bytes can be replayed through the real browser SDK. DOM/controller
tests can instead inject their ID factory.

## Reproduce

From the repository root with supported Bun 1.3.14 and prepared workspace packages:

```sh
GOODVIBES_TEST_NATIVE_INTAKE_FIXTURE_DIR="$PWD/.tmp/native-intake-captures" \
  bun packages/engine/scripts/test.ts --cwd ../../products/daemon \
  src/test/runtime/native-intake-http-capture.test.ts
```

To replace checked-in evidence, copy the seven exported JSON files unchanged.
Runtime IDs naturally change between runs; do not normalize individual fields.
Then validate and run the browser proof:

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/webui \
  e2e/support/native-intake-fixture.test.ts
cd products/webui
bunx playwright test e2e/native-intake.e2e.ts \
  --project=phone --project=desktop --workers=1
```
