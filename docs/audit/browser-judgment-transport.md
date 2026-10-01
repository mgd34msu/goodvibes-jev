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
The HTTP transport supplies a fresh `currentPrincipal()` guard, rechecked after
body admission, source resolution, provider-queue waiting and completion. Reference
resolution receives this function rather than a cached principal/scopes snapshot.

Admission bounds: 64 KiB UTF-8 body, five-second body deadline, JSON depth 16,
4096 nodes, 32768 aggregate text characters, 128 array items, 64 palette candidates,
and 256-character query/reference fields. Full resolved input privacy inspection
precedes projection, logging, or provider access. Each reader additionally owns
its exact resolved-input limits (including the error/status field limits).

Execution bounds: four logical runs per principal, sixteen total, thirty-second
logical deadline, four concurrent provider calls per run and eight globally.
Each adapter's declared total is capped at 64 logical calls. Queueing exists
only inside already-admitted bounded fan-out. Cancellation removes queued calls.
Shutdown closes admission, aborts work, and waits for the actual owned promises;
a five-second failed drain is reported rather than called successful.

The separate reference store owns at most 64 in-memory snapshots, each at most
64 KiB and five minutes old. It checks principal, battery, expiry, current source
revision and read permission. Reference possession never grants hosted/local
provider transmission: the separately injected server authorization policy must
approve the source binding and current route. A route's assertion is checked
before every logical provider call and before delivery. These checks do not yet
cover the settings port's asynchronous key lookup or each retry/fallback fetch.
Private-source installation requires an actual-dispatch guard, a finite wire
attempt budget, and revocation-safe log admission before it may be enabled.
Assertion hooks are synchronous: any non-undefined result is refused. Grants
require literal `true`; Promises and other truthy values cannot grant access.
Rejected thenables are consumed without exposing their rejection text.

Each installed adapter declares its fixed questions and maximum call count. The
scoped port refuses new/different questions and provides server-owned log context.
Input text is state, never question text. Error readings are independent yes/no
readings; status selects the requested closed vocabulary; palette values
contain complete unique candidate indices and finite probabilities with stable
ties. Held/uncertain results contain readings and aggregate outcome but no value.
Held readings use the same closed names and vocabularies as settled readings:
the five error names, `badge` or `library_dot`, and `candidate_0` through the
last requested candidate. One explicitly attributed structural exception permits
four error readings: `structuralBasis: { method_unknown: 'http-status-not-404' }`
must match a valid non-404 HTTP status in the resolved server snapshot. Only then
may `method_unknown` be omitted from readings and its settled value be `false`.
The browser cannot supply the status or basis, and no fifth model reading is
invented. A missing or invalid server status cannot establish this fact.

For compound uncertainty, a held adapter projection may declare a server-only
`compoundOutcome` of `confirm` or `escalate`. The response's single aggregate
outcome is the strongest genuine item outcome or this minimum; it never lowers
an item outcome. An all-act compound conflict needs this explicit minimum to
hold. The instruction itself is omitted from the wire response, and held results
never contain a value or aggregate `act`. These are additive protocol-v1 adapter
fields; they do not change the client input schema or grant any provider access.

Known machine error codes are handled structurally by
callers before this semantic endpoint. They do not become synthetic model readings
or metadata-only success; an endpoint answer requires a genuine recorded call.

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
The product composition test boots the actual `createRuntimeServices` graph and
proves exact recorded-port injection, accepted-call drain before SQLite disposal,
factory/inbox acquisition rollback and clean rebuilding with the same config.
