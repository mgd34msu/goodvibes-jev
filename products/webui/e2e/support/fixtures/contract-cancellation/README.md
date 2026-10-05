# Authenticated contract cancellation captures

These ten JSON files are exact response bytes exported by
`packages/engine/test/contract/cancellation-http.test.ts`. They are not generated
from the synthetic browser seed and do not replace the existing contract
inspection captures.

The fixture starts an ephemeral loopback HTTP listener and uses the production
`UserAuthManager`, `DaemonControlPlaneHelper`, REST route dispatch, method catalog,
contract operator service, real contract runner, AgentManager, and contract store.
The planner, route selector, and model executor remain scripted test boundaries;
this is not a live-provider or external daemon test.

The authenticated test checks missing/invalid tokens (401), a real read-only
session (403), and the declared `write:fleet` scope. A writer session sends the
POST to the generated `contracts.cancel` route, with `contractId` in the path and
only the reason in the body, as the browser facade does.

- `live-before-*` records an actual running shared-isolation contract.
- `live-cancel.json` is its `{ "cancelled": true }` acknowledgement.
- `live-after-*` records terminalization while child cleanup is still held by an
  explicit barrier. The runner's join has not settled and a file already written
  remains unchanged. Acknowledgement therefore does not prove drainage or undo.
- `retained-before-*` records an unmodified checkpoint from a real running
  contract, held in another store without launching or resuming a runner.
- `retained-cancel.json` is its `{ "cancelled": false }` response.
- `retained-after-*` is byte-identical to the corresponding before response:
  the contract still says running, but no live runner was cancelled.

Temporary project paths, ids, timestamps, evidence and complete response shapes
are preserved. No fixture fields are normalized, scrubbed or filled in. The
browser loader validates all records against the canonical engine schemas and
the generated product inspection schema before using them. Browser error cases
explicitly inject a disconnected, malformed or 503 response around these captures.

## Reproduce

From the repository root, with the supported Bun 1.3.14 on PATH:

```sh
GOODVIBES_TEST_CONTRACT_CANCELLATION_FIXTURE_DIR="$PWD/.tmp/contract-cancellation-captures" \
  bun packages/engine/scripts/test.ts test/contract/cancellation-http.test.ts
```

To deliberately replace the checked-in captures, copy all ten exported files
unchanged from that directory, then run the capture validation and phone/desktop
browser tests. Captures from a new run naturally have different runtime ids and
timestamps; do not edit individual values to hide those differences.

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/webui \
  e2e/support/contract-cancellation-fixture.test.ts
cd products/webui
bunx playwright test e2e/contract-cancellation.e2e.ts \
  --project=phone --project=desktop --workers=1
```
