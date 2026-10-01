# Authenticated browser judgment transport

The direct route is `POST /api/judgment/batteries/run`, catalog method
`judgment.battery.run`, protocol version 1. Its `invokable: false` is intentional:
the direct HTTP route preserves the original request cancellation signal; generic
gateway/WS invocation is refused. The operator contract and generated WebUI route
map carry the same request/result schemas.

## Ownership and installation

- Protocol and HTTP boundary: `packages/engine/daemon-sdk/src/browser-judgment-*`
- Server adapters and ownership: `sdk/src/platform/judgment-browser`
- Actual product readers/batteries: separately owned `platform/judgment-browser/batteries/webui-*`
- Daemon composition accepts an explicit `createBrowserJudgment(judgment)` factory.
  It receives that graph's configured, recorded port. The new service's awaited
  close is registered after judgment composition, so accepted work drains before
  its decision log closes. The router only borrows the capability.
- There is no production default battery, reference producer, outbound grant, or
  provider. Missing capability, installation, reference, grant, or route remains
  unavailable/held. This transport alone does not establish live WebUI readiness.
- SDK synchronous runtime ownership is unchanged. Embedders supplying the optional
  capability must own and await its `close()` before disposing the borrowed log.

## Boundaries

Requests authenticate using existing operator identities and require admin or
`write:judgment`. Cookie calls require an exact trusted Origin. A missing Origin
is allowed only with an explicit Bearer header. Configured CORS origins are
accepted only while CORS is enabled. Trusted same-origin URLs are derived from
server configuration, never Host/forwarded headers. Credentials, query-string
input, arbitrary prompts/questions/models/routes, and unknown JSON fields are not
part of this protocol. Responses are non-cacheable. Clients must not enable POST
retries or persist results; a UUID is correlation, not an idempotency guarantee.

Admission bounds: 64 KiB UTF-8 body, five-second body deadline, JSON depth 16,
4096 nodes, 32768 aggregate text characters, 128 array items, 64 palette candidates,
and 256-character query/reference fields. Full resolved input privacy inspection
precedes projection, logging, or provider access. Each reader additionally owns
its exact resolved-input limits (including the error/status field limits).

Execution bounds: four logical runs per principal, sixteen total, thirty-second
logical deadline, four provider calls per run and eight globally. Queueing exists
only inside already-admitted bounded fan-out. Cancellation removes queued calls.
Shutdown closes admission, aborts work, and waits for the actual owned promises;
a five-second failed drain is reported rather than called successful.

The separate reference store owns at most 64 in-memory snapshots, each at most
64 KiB and five minutes old. It checks principal, battery, expiry, current source
revision and read permission. Reference possession never grants hosted/local
provider transmission: the separately injected server authorization policy must
approve the source binding and current route. A route's assertion is checked
before every provider call and before delivery. Composition must make this
assertion truthful when live endpoint/model/credential configuration changes.

Each installed adapter declares its fixed questions and maximum call count. The
scoped port refuses new/different questions and provides server-owned log context.
Input text is state, never question text. Error readings remain five independent
yes/no readings; status selects the requested closed vocabulary; palette values
contain complete unique candidate indices and finite probabilities with stable
ties. Held/uncertain results contain readings and aggregate outcome but no value.

## Evidence and verification

Only actual recorded decision IDs, model IDs, usage and latency are returned as
evidence. No raw input, source handle, endpoint URL, token, or state hash is added
to the response. The decision log's existing state hash remains server-side.
Fixed error codes/messages replace private exceptions. The independent recording
boundary fix normalizes borrowed-port answers and metadata before persistence.

Focused tests use synthetic ports and in-memory logs. They cover strict schema
and byte admission, authentication/CSRF, cancellation, reference ownership,
full-input privacy holds, uncertainty, unavailable installation, bounded fan-out,
route/source changes and asynchronous drain. Synthetic success is not live
provider calibration. No live provider key or fabricated reading is installed.
