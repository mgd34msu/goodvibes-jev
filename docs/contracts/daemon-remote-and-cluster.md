# Daemon remote routing and cluster ownership

Remote execution, persisted routing and cluster leadership have separate owners. A stored peer,
elected role, resolved credential or successful transport exchange supplies only its declared
capability. Compose their readiness, admission and shutdown boundaries explicitly; do not infer
permission from command text, model confidence or the availability of a backend.

## Authority and public entry points

Reuse the canonical gateway descriptors, route schemas and public engine entry points. Host backends
consume only the `resolveRef` credential port, home/working directories and `info`/`warn`/`error`
logger methods. `HostDistributedRuntime` forwards the manager operations and sends `invokePeer`
through the host dispatcher; it does not define a second catalog or authorize execution.

The existing `channels.routing.assign` and `channels.routing.delete` catalog handlers retain the
shared explicit-confirmation guard: both `body.confirm === true` and trusted
`context.explicitUserRequest === true` are required, otherwise `REQUIRE_CONFIRM` is a 403. Preserve
the canonical admin access and the destructive delete declaration. The remote HTTP invoke route
separately checks `requireAdmin`, declared body shape and payload limits before calling the service.
Calling a backend directly is not a substitute for these public admission boundaries.

Semantic decisions follow the [autonomous Jev decision
contract](../design/autonomous-jev-decisions.md). Historical human-confirmation vocabulary is not an
autonomous decision receipt: never turn `confirm` or `escalate` into `act`, fabricate an explicit
request or bypass destructive confirmation. An autonomous consumer must use current host-bound
evidence, deterministic authentication/scope/revocation checks and the execution claim required by
that contract. Replacing a compatibility entry point requires an explicit admission migration; these
backend and routing contracts do not perform one.

Implementation:
[host-handlers.ts](../../packages/engine/sdk/src/platform/control-plane/host-handlers.ts#L108-L150),
[remote-routes.ts](../../packages/engine/daemon-sdk/src/remote-routes.ts#L533-L560),
[context.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/context.ts#L1-L11).

## Persisted channel and profile bindings

Owner-authored assignments resolve in this order: exact surface plus route, surface-only assignment,
explicit `any` surface without a route, then `null`. Message text, sender digest, conversation kind,
confidence scores and model heuristics cannot choose a profile. The inbox bridge maps provider to
surface and forwards an optional route refinement; it returns the owner’s profile ID or `undefined`
when no binding matches. It does not invent a delivery address. A live-store exception remains a
failure, not evidence of an absent binding.

Keep `channel-routes.sqlite` under the handler store’s `.goodvibes/tui/operator` path and preserve
its routes schema. Parse composite IDs at the first colon, retaining further colons in the route ID;
a trailing empty route collapses to a surface-only assignment. Assignment IDs and creation
timestamps survive updates. Lists use descending update time then ascending assignment ID, with
exact profile/surface filters. Trim nonempty labels and omit absent optional fields. List output
maps `assignmentId` to `id` and excludes internal `channelId`; it must match the canonical generated
output contract.

Capture each mutation’s actual row before awaiting persistence, so overlapping updates or a
subsequent delete cannot replace the earlier caller’s receipt. A failed save still rejects that
caller. Store close fences admission immediately, awaits initialization and accepted mutation
promises, then releases the handle. Close is idempotent and awaitable; ignored legacy calls observe
rejection, while product shutdown awaits completion. A released `RouteStore` never reopens: use a
fresh instance. Failed initialization may retry while open; post-release access keeps
`ROUTING_STORE_UNINITIALIZED`. Save ordering is process-local and does not provide cross-process
write transactions.

Preserve storage/resolver and public-consumer assertions. Use isolated fixture profiles and
temporary databases to exercise overlapping assignments, delete-after-write, held persistence across
close, late initialization, restart, omitted optional fields and generated list-item typing; no user
routes or provider traffic are needed.

Implementation:
[routing-resolver.ts](../../packages/engine/sdk/src/platform/channels/host-routing/routing-resolver.ts#L18-L48),
[route-store.ts](../../packages/engine/sdk/src/platform/channels/host-routing/route-store.ts#L24-L62),
[route-store.ts](../../packages/engine/sdk/src/platform/channels/host-routing/route-store.ts#L280-L355),
[route-store.ts](../../packages/engine/sdk/src/platform/channels/host-routing/route-store.ts#L173-L223).

## Routing registration readiness and retirement

Routing registration attaches typed handlers to the existing `channels.routing.list/assign/delete`
descriptors. Construction is lazy and opens no SQLite database. Catalog methods initialize when
called; callers of synchronous resolver handles must first await `initialize()` before enabling
intake leadership. Initialization failure is retryable, but closing during initialization rejects
readiness rather than declaring a stopped surface ready. Preserve required assignment/profile
fields, explicit composite-ID precedence, list-limit normalization, response projection and
principal/assignment logging metadata.

Close immediately detaches catalog admission and rejects new resolver or initialization calls. Drain
accepted handlers through persistence, then await `RouteStore.close()`. Restore the original
canonical descriptors without handlers so a replacement can reuse the catalog. Await close before
transferring ownership; an older repeated teardown must not erase replacement handlers. Direct
advanced store handles remain the caller’s responsibility and cannot be used after shutdown begins.
`unregister()` starts the same observed cleanup with fixed diagnostics; it is not a completion
barrier.

Validate accepted cold reads and assignments held across teardown, handlerless descriptor
restoration, lazy readiness, unused close without file creation, startup cancellation, persisted
assignments after fresh reopen, initialization retry, post-close refusal and observable legacy
cleanup errors. Exercise actual product handler aggregation and provider routing alongside isolated
temporary-store fixtures.

Implementation:
[registration.ts](../../packages/engine/sdk/src/platform/channels/host-routing/registration.ts#L143-L193),
[registration.ts](../../packages/engine/sdk/src/platform/channels/host-routing/registration.ts#L270-L305),
[index.ts](../../products/daemon/src/daemon/handlers/index.ts#L60-L89).

## Backend peer records and paired peers

The host `PeerRegistry` stores backend configuration in
`.goodvibes/tui/operator/peer-registry.sqlite`, with `peerId` as primary key and display name,
backend kind and JSON backend configuration. Its closed kinds are `local-process`, `docker`, `ssh`
and `cloud-terminal`. Registration upserts a normalized record; lookup reads the primary key,
listing sorts by peer ID, and removal remains possible for a corrupt row without first decoding it.
Revalidate stored JSON types, kind membership, port bounds and reference grammar on reads;
corruption must fail explicitly.

SSH requires host, user and an identity reference; a supplied number or numeric string port
normalizes to an integer from 1 through 65535. Cloud requires declared `gcp`/`aws`/`azure` provider
and credential reference, with optional project, location and instance fields. Local configuration
preserves optional cwd and cleans an explicitly supplied command allowlist. Docker requires
container name and permits a credential-free plain/local host or a valid reference. Reject embedded
`@` userinfo, malformed `goodvibes://` references, and raw `https://` or `tcp+tls://` Docker hosts.
Credential-bearing fields require both the exact `goodvibes://secrets/` prefix and the full
secret-reference parser; a prefix-only classifier is insufficient.

Registry initialization shares its in-flight promise and records a generation. Closing during
initialization closes the late database and rejects that initialization; explicit later
initialization can reopen the registry. This differs from the permanently released `RouteStore`.
Preserve concurrent registration/restart assertions, safe normalization, corrupt-row
refusal/removal, idempotent close and post-close refusal using test-owned databases.

A host backend record is distinct from the distributed manager’s paired-peer record and work queue.
The surface’s public service does not expose `PeerRegistry.register`; paired records do not supply
backend configuration. The real queue requires a matching peer ID and must refuse a host-only peer
rather than invent a pairing. An operator provisioning integration must explicitly establish the
intended backend and paired records under existing authentication/admin boundaries, invoke through
the normal route, preserve restart persistence, and reject malformed or raw-credential input.
Constructing these libraries or seeding fixture SQLite rows does not supply that integration.

Implementation:
[peer-registry.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/peer-registry.ts#L4-L14),
[peer-registry.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/peer-registry.ts#L164-L234),
[peer-registry.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/peer-registry.ts#L386-L428),
[surface.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/surface.ts#L119-L136),
[distributed-runtime-work.ts](../../packages/engine/sdk/src/platform/runtime/remote/distributed-runtime-work.ts#L95-L162).

## Dispatcher receipts and shutdown

The backend factory maps the four declared kinds to local, Docker, SSH and cloud implementations.
Construction executes no child/provider command and resolves no credential. Scratch preparation
inspects owner metadata and may remove only marker-proven stale owned directories. Validate peer ID
and command before opening storage, await registry initialization before lookup, and recheck
admission afterward. Missing peers or backend kinds refuse explicitly; no semantic fallback selects
a substitute. Pass the command and payload through unchanged.

Only explicit async dispatch with a configured work enqueuer enters the queue. Preserve peer/backend
attribution and the requesting principal as `queuedBy`; the surface forwards it to the manager as
actor. Otherwise dispatch synchronously. Receipts preserve optional exit/work IDs and completion
state, cap stdout and stderr previews at 4,096 characters, and compute the full 64-hex SHA-256 over
the entire returned stdout before truncation.

Teardown closes admission synchronously and stores one shared promise before invoking potentially
reentrant hooks. Start every backend stop before awaiting accepted dispatches and enqueues,
including cold initialization. One synchronous or asynchronous teardown error must not skip other
backends. Preserve best-effort backend cleanup and fixed warning plus backend kind; do not log
arbitrary exception or credential text. The dispatcher never closes its borrowed registry. Accepted
durable queue writes are awaited rather than represented as cancelled. An injected backend without
cancellation may keep shutdown pending until accepted work settles; do not abandon ownership with an
arbitrary deadline.

Validate cold persisted registries, pre-open input checks, initialization retry/failure, close
during initialization, reentrancy, cleanup fan-out, held dispatch/enqueue, missing backend and
construction without execution. Cover local/Docker kill-and-reap, post-close refusal, late
credential lookup, safe resolver/child errors and exact known-value output masking. Keep original
dispatcher and service assertions.

Implementation:
[index.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/index.ts#L21-L40),
[dispatcher.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/dispatcher.ts#L121-L183),
[dispatcher.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/dispatcher.ts#L186-L209).

## Remote surface ownership

`registerRemoteSurface` composes registry, dispatcher, host route adapter and distributed queue
synchronously, retaining `.goodvibes/tui/remote/distributed-runtime.json` for its owned manager.
Await `ready` before exposing synchronous reads; asynchronous service calls await readiness
themselves. Early reads refuse with `REMOTE_SURFACE_NOT_READY`, initialization failure with
`REMOTE_SURFACE_START_FAILED`, and closed calls with `REMOTE_SURFACE_CLOSED`. Do not log raw
initializer errors. Failed startup remains failed: retry with a fresh registration.

Surface close immediately fences admission and shares one promise. Stop backend work, await both
actual initializers and all accepted service calls, drain an owned manager’s write queue, and close
the registry. Immediate close before initializers run must create no stores; when startup has begun,
a failure on one side cannot release the other side early. Best-effort backend failures keep the
dispatcher’s fixed warning behavior; other cleanup failure becomes `REMOTE_SURFACE_CLEANUP_FAILED`
after registry cleanup. An accepted queue write may finish. `unregister()` observes rejection but
callers requiring completed cleanup must await `close()`.

An injected manager is borrowed: the surface neither starts nor drains/disposes it. Its creator may
supply `managerReady`, or must provide an already usable manager; a readiness promise without an
injected manager is invalid. Close still awaits calls accepted through this surface, while the
creator owns other users and final manager shutdown. The product runtime owns borrowed-manager
startup and write drainage outside the remote surface, and its handler assembly awaits routing and
remote readiness.

Use explicit readiness/close barriers rather than sleeps. Validate borrowed ownership, accepted
work, early close, one failed and one held initializer, safe startup errors with corrupt JSON left
available as evidence, owned write drain, observable cleanup errors, and cancellation held until the
mocked backend child exits. With a real manager on temporary paths, verify host-only peer refusal
and matching fixture records in both stores that enqueue with attribution and survive restart. Do
not provision real pairing tokens or credentials.

Implementation:
[surface.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/surface.ts#L53-L117),
[surface.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/surface.ts#L138-L156),
[services.ts](../../products/daemon/src/runtime/services.ts#L12-L43).

## Process deadlines and backend lifetime

The internal runner requires `Bun.spawn`, discrete argv and optional cwd/env/stdin. It captures
stdout, stderr, actual exit status and timeout state. In the default mode used by these backends,
start the deadline immediately after spawning, drain both outputs while writing input, and race the
complete operation against the deadline. Timeout, cancellation and I/O failure stop the owned child
and await its exit; cancel stream readers, observe late stdin rejection and clear timer/listeners on
every terminal path. A pre-aborted signal never spawns; active cancellation rejects with
`AbortError` after cleanup. Nonzero process exit remains a returned result.

Default POSIX execution uses a detached process group and stops ordinary same-group descendants on
timeout/failure even if the leader already exited. Deliberately detached or new-session descendants
can escape; this is not a security sandbox. Windows default mode terminates the direct child without
claiming process-tree containment. Default normal completion leaves intentional background work
unchanged. The runner’s separate `ownedProcessGroup` opt-in joins actual I/O and group settlement,
refuses Windows before spawning, and must not be confused with the backend default.

`BackendLifetime` owns accepted asynchronous operations. Close stores one promise before aborting,
refuses future work, prevents late credential lookups from resuming dispatch, waits actual owned
filesystem/process I/O and invokes final cleanup once, including reentrant close from an abort
listener. Lookup cancellation does not grant permission to race filesystem writes against removal.
Cleanup failure remains visible. Local and Docker backends use the same lifetime and AbortSignal
discipline as SSH and cloud.

Keep argv emptiness, runtime method availability, stream flags, exit status, deadlines and platform
branches deterministic. Preserve direct-child and stream-deadline assertions, blocked stdin, I/O
failures and late rejection handling. On POSIX, use local descendants that retain pipes and ignore
SIGTERM, plus delayed marker assertions proving work did not continue after SIGKILL. Report
unavailable Windows process-group coverage explicitly instead of passing no-op tests; preserve the
no-skipped-tests gate. Test programs must not perform network I/O.

Implementation:
[process-runner.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/process-runner.ts#L222-L296),
[process-runner.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/process-runner.ts#L99-L109),
[process-runner.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/process-runner.ts#L156-L219),
[backend-lifetime.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/backend-lifetime.ts#L7-L73).

## Owned credential files and privacy

`OwnedCredentialDirectory` creates a private per-instance directory under the existing scratch root.
Use generated filenames, exclusive creation, 0600 file modes and 0700 directory modes. Peer IDs
never become paths. Validate the closed `key`/`cred` file-kind enum at runtime. Write a marker
containing namespace/version, directory name and PID before any credential file.

Startup removal requires a valid matching owner marker and definite dead-owner evidence. Only ESRCH
proves death; live owners and unknown errors preserve their directories. Retain unmarked legacy
files, malformed markers and unknown entries, logging only a count. Refuse existing symlinked path
components, skip symlinked entries/markers, open markers without following symlinks and recheck
root/directory identity before removal. Never follow nested symlinks. These checks are not an
adversarial same-user filesystem sandbox or a portable race-free openat guarantee.

Single-file cleanup accepts only a file created by that instance and verifies directory identity.
Teardown waits pending writes before removing only its own directory, leaving active peers and the
legacy root intact. Resolved credentials must not appear in logs, model inputs, returned output or
thrown raw errors. Credential-bearing adapters substitute only exact known resolved strings in
stdout/stderr and use fixed typed lookup/child errors; noncredential output stays unchanged. Literal
masking does not detect unrelated secrets, transformed or fragmented values.

Use dummy credential strings and owned temporary roots. Validate independent active instances, exact
owned single-file removal, valid/malformed markers, live/dead/unknown PID probes, traversal refusal,
outside-target survival and held writes across close. Keep real symlink fixtures in an explicit
POSIX boundary; do not change Windows privileges/configuration to make them pass. Mocked SSH
multiplexing fixtures run cross-platform with normalized separators; unavailable filesystem coverage
must remain visible.

Implementation:
[owned-credential-directory.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/owned-credential-directory.ts#L8-L32),
[owned-credential-directory.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/owned-credential-directory.ts#L62-L95),
[owned-credential-directory.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/owned-credential-directory.ts#L98-L153),
[owned-credential-directory.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/owned-credential-directory.ts#L156-L191),
[credential-output.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/credential-output.ts#L1-L4).

## Local and Docker execution

Local commands are tokenized into discrete argv without a shell, honoring quotes and escapes; append
payload args literally. Reject incomplete trailing escape, unterminated quote and an empty quoted
executable before spawn. Payload cwd overrides configured cwd, environment overlays the inherited
environment, and stdin is optional. An omitted allowlist imposes no executable restriction at this
layer; a supplied list compares exact executable strings rather than basenames, and an empty list
permits nothing. These are grammar and membership checks, not command-meaning judgments.

Docker invokes tokenized local `docker exec`, using `-i` when stdin is supplied and passing the
remote command to `sh -c`. SSH/cloud likewise retain remote-shell semantics: payload args are joined
with single spaces without escaping, so callers needing literal arguments must quote them in the
declared command/args. Resolve Docker host references into `DOCKER_HOST` environment only, never
argv; preserve credential-free configured socket/host addresses. Refuse wrong backend kind, empty
command or unresolved required host before spawning. Fence late resolution after close and mask
exact resolved host bytes in returned output.

A positive finite requested timeout is capped at 600,000 ms; otherwise use 120,000 ms. Backend
timeout results use exit code 124 and the backend-specific timeout marker while preserving normal
exit codes and output. Intercept Docker and all credential-bearing external CLI spawns in tests;
retain grammar, literal args, cwd/env/stdin, allowlist, timeout, missing-reference and public
admin-denial assertions.

Implementation:
[local-process.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/local-process.ts#L14-L122),
[docker.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/docker.ts#L23-L97),
[types.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/types.ts#L79-L96),
[types.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/types.ts#L59-L68).

## SSH identities and multiplexed connections

SSH preserves identity-file and port arguments, batch mode, 15-second connect timeout,
`StrictHostKeyChecking=accept-new`, optional env/stdin and the remote-shell command. A normal owned
socket uses `ControlMaster=auto` and 60-second persistence. Pool bindings include credential
reference, host, user and port. Reserve a lease before awaiting identity creation, share concurrent
creation for the same binding, and retire changed bindings only after their final lease. Evict
failed lookups so a later call can retry.

Keep keys under the instance-owned legacy `ssh-keys` root. Teardown cancels owned CLI work, waits
active leases, requests an existing multiplexing master to exit, then removes private key material.
The cleanup command targets only the exact owned socket with `ssh -F none -S <socket> -O exit --
<target>` and must not consult unrelated SSH configuration. Surface master-cleanup failure even
after removing private files. A deliberately detached master can survive a hard process crash until
idle expiry; no immediate crash-time remote cancellation is promised.

Use a conservative 100-byte owned Unix-socket path budget. If a configured home makes the path
longer, disable sharing with a warning and retain command execution, without creating an unowned
short-path directory. This is a filesystem resource bound. Validate pending-identity sharing,
rotation while leased, failed lookup retry, traversal-safe peer IDs, known-key masking,
cross-instance survival, late lookup after close, child exit before key removal, exact mocked master
exit and visible cleanup failure. Emulate the long-path branch without live SSH or control sockets.

Implementation:
[ssh.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/ssh.ts#L36-L118),
[ssh.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/ssh.ts#L56-L87),
[ssh.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/ssh.ts#L120-L165).

## Cloud terminal command forms

Cloud command forms are explicit protocol choices. GCP runs `gcloud compute ssh`, optional
`--project`/`--zone`, configured instance or `cloudshell`, and `--command`; its credential-file
environment key is `CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE`. AWS runs `aws ssm start-session`,
optional `--region`/`--target`, `--document-name AWS-StartInteractiveCommand`, and `--parameters
command=<remote command>`, with `AWS_SHARED_CREDENTIALS_FILE`. Azure runs `az vm run-command
invoke`, optional `--resource-group`/`--name`, `--command-id RunShellScript`, and `--scripts`, with
`AZURE_AUTH_LOCATION`. Preserve optional fields, payload environment/stdin, remote-shell args and
timeout-to-124 behavior.

Resolve each credential through the narrow store, write a single-use generated file in the
instance-owned `cloud-creds` directory, and supply only its path through the provider environment.
Fence after lookup/write before dispatch. Always remove the owned file in `finally`; close must stop
and reap active local CLI work before final credential cleanup. Mask only the known value and use
fixed typed lookup/child failures. Intercept every provider spawn, including teardown, and assert
all three argv/env forms using dummy values and temporary paths; command construction alone does not
establish account setup, provider permission or successful remote execution.

Implementation:
[cloud-terminal.ts](../../packages/engine/sdk/src/platform/runtime/remote/host/backends/cloud-terminal.ts#L18-L109).

## One-shot daemon transport protocols

Keep WebSocket and raw-reply helpers beside the terminal-shell target resolver and verb reader; an
SDK-to-terminal-shell dependency would create a cycle. The public terminal-shell entry exports the
helper functions/types and timeout constant. Use the resolved target’s token and `isLocal` field;
derive WebSocket scheme from its HTTP(S) URL. Protocol checks use declared JSON shapes and exact
frame kind/auth result/call ID, never prose meaning, work-quality rankings or heuristic permission
fallback.

A WebSocket call owns one connection and a default 15-second deadline. Put the operator token in
both upgrade Authorization and the auth frame. Send auth once after open and the call once after a
successful auth acknowledgment; ignore auth acknowledgments before auth and responses before call or
with a different call ID. Duplicate opens/auth frames and late callbacks after settlement cannot
trigger a second request or credential transmission. A synchronous send failure settles and closes
the socket. Every terminal path clears the timer and closes; pass through protocol error/fix strings
and keep target-specific fallback errors.

Callers declare `wrapped` or `raw` reply envelopes; never sniff a payload’s `ok` field to choose.
Preserve 401/403/404 status handling. Raw HTTP 2xx payloads become wrapped success, other statuses
become refusal, and non-JSON remains an unreadable-reply failure through the shared reader. Check
null/scalar/missing error fields safely and pass through only string error/fix values; fallback
wording includes actual status and requested path. Keep default WebSocket/HTTP loopback tests, both
token placements and phase/duplicate/late-callback/null-body regressions. Loopback transport checks
do not authorize provider or production-daemon calls.

Implementation:
[daemon-ws-call.ts](../../packages/engine/terminal-shell/src/daemon-ws-call.ts#L16-L30),
[daemon-ws-call.ts](../../packages/engine/terminal-shell/src/daemon-ws-call.ts#L102-L257),
[raw-reply-route.ts](../../packages/engine/terminal-shell/src/raw-reply-route.ts#L50-L113).

## Cluster election, membership and admission lifetime

Use one product coordinator as the election owner. The group layer owns the socket and lends a
signed election transport; late-bound closures read the coordinator’s actual mastership and surface
holdings rather than maintaining a second tally. Each inbox account has its own election surface and
network discriminator is a digest, not its account name. Identity state is surface-scoped. Group key
material belongs in the encrypted secrets store, never config, logs or status. Optional
transport/clock injection retains production UDP and system-clock defaults.

Start the group before the coordinator. Concurrent starts share actual readiness through the return
announcement; a failed start cannot be remembered as success. Stop cancels the group runtime first
so a pending join/rejoin admission settles, then awaits accepted startup and transport cleanup.
Share stop completion, allow explicit restart after clean shutdown and keep cleanup failure
observable. Admission owns an identity-scoped deadline that is cancelled on abandonment, failed
send, successful/synchronous settlement and housekeeping expiry; handle settlement during send
before the timer handle exists. Natural expiry must still settle correctly. Lifecycle cleanup cannot
relax join/rejoin authentication, roster membership, key handling or reply policy.

Poller gate `start()` resolves only when polling has begun; `stop()` resolves only when no further
poll can run. Actual registration/provider boundaries must consume the same coordinator. Clustered
Slack and email compositions require owned gate retirement and current account eligibility; Slack
also requires owned account invalidation. Recheck stable configured scope and preserve
account/generation protection. Election does not authorize provider access, gate
outbound/control-plane work or transfer inbox cursors: each node resumes its own local state, so
bounded cold initialization and possibly stale standby reads do not imply exactly-once delivery.

Validate elected surfaces, reasons and account-name privacy with `MemoryClusterBus` and
`FakeClusterClock`, starting group then coordinator and closing both owners without UDP sockets.
Cover concurrent/failed start, stop during return, clean restart, cleanup failure and all
independent admission deadline cases with dummy key material in memory/owned roots. Keep actual
inbox-registration assertions in addition to gate-only tests. At product level use real
`createRuntimeServices` plus `DaemonServer`, ephemeral loopback HTTP/gateway calls and fully awaited
shutdown with synthetic inbox/provider owners. These fixture techniques do not establish live
Jev/provider operation.

Implementation:
[cluster-group-composition.ts](../../products/daemon/src/runtime/cluster-group-composition.ts#L215-L256),
[cluster-group-composition.ts](../../products/daemon/src/runtime/cluster-group-composition.ts#L161-L199),
[group-admissions.ts](../../packages/engine/sdk/src/platform/cluster/group-admissions.ts#L535-L588),
[slack-inbox-composition.ts](../../products/daemon/src/runtime/slack-inbox-composition.ts#L66-L123),
[email-inbox-composition.ts](../../products/daemon/src/runtime/email-inbox-composition.ts#L65-L104).

## Validation boundaries and change control

Keep original behavioral tests, public consumer type fixtures and route/schema assertions. Apply the
repository’s focused-test procedure plus applicable declaration/API, architecture, line-cap,
judgment and browser-neutral checks when changing these contracts or their owners. The daemon’s
[testing and validation guide](../../products/daemon/docs/testing-and-validation.md#local-commands)
defines the product procedure. Use owned temporary databases, dummy credentials, in-memory cluster
transports, intercepted provider commands and isolated local runner processes. External
SSH/cloud/Docker/accounts, persistent keys and production credential stores require separate
authorized validation.

Changes from a pinned upstream release require their own reconciliation before compatibility or
product-parity claims; command-shape or synthetic lifecycle assertions do not replace
composed-product, platform or live-provider acceptance. Historical source pins, original assertions,
execution receipts and acceptance tracking are preserved with the current [TA-18
owner](https://linear.app/the-artificery/issue/TA-18/port-daemon-composition-and-remote-cluster-infrastructure).
Historical THE identifiers remain historical labels.
