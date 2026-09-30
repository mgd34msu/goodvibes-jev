# Daemon cluster transport hoist

Source: `mgd34msu/goodvibes-daemon` at
`443e5ee4d6cda0d36d57e2886398d0836074a4a9`. This is the first bounded THE-18
slice, not a completed daemon composition.

The two transport helpers belong beside the engine terminal-shell's existing
cluster target resolver and verb reader. Placing them in the SDK would create
an SDK-to-terminal-shell dependency cycle. The existing terminal-shell public
entry now exports the functions, types and timeout constant.

| Upstream file | Target |
|---|---|
| `src/cluster/daemon-ws-call.ts` | `packages/engine/terminal-shell/src/daemon-ws-call.ts` |
| `src/cluster/raw-reply-route.ts` | `packages/engine/terminal-shell/src/raw-reply-route.ts` |
| `src/test/cluster/daemon-ws-call.test.ts` | `packages/engine/test/daemon-cluster-ws-call.test.ts` |
| `src/test/cluster/raw-reply-route.test.ts` | `packages/engine/test/daemon-cluster-raw-reply.test.ts` |

## Decisions re-read

- Frame parsing reads the declared JSON protocol and field types. Frame-kind,
  auth-result and call-id comparisons are exact protocol comparisons
- The one-shot auth/call flags and settled flag are transport state. They
  prevent repeated frames or callbacks from sending a second invocation
- The timeout is a duration bound, not a judgment about the work
- Local/remote wording follows the target resolver's `isLocal` field. Error
  and fix fields are passed through when the protocol supplies strings
- HTTP 2xx and 401/403/404 decisions read status codes. Envelope selection is
  the caller's declared `wrapped`/`raw` value; payloads are never sniffed for it
- Missing/null/scalar error fields are JSON shape checks. The fallback wording
  names the actual status and requested path
- HTTP-to-WebSocket scheme conversion follows the target URL's protocol

No decision in these helpers reads prose meaning or work quality, so no new
judgment battery was introduced and no heuristic fallback was added.

## Defects corrected during the port

- Null JSON error bodies no longer throw while reading `error` or `fix`
- Duplicate opens/auth frames cannot send duplicate requests
- Late callbacks after timeout or completion cannot transmit credentials
- Auth acknowledgments and responses are ignored before their protocol phase
- A synchronous socket send failure settles the request and closes its socket

The original assertions remain. Added regressions cover these cases plus both
upgrade/auth token placements. `daemon-cluster-wire.test.ts` exercises the
default WebSocket and HTTP dependencies over a real loopback fixture server.
The focused transport/cluster suite passes 61 tests across five files. This
does not establish composed-daemon or product parity, and calls no external
provider or production daemon.
