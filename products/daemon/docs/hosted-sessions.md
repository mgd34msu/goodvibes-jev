# Hosted sessions

A hosted session runs its conversation loop inside the daemon. Its record and
transcript belong to that host. Whether the session continues after its last
client leaves depends on its detach policy.

The daemon composes each session with tools, model providers, and a workspace
runtime. Workspace trust applies to the session's workspace, rather than the
daemon's working directory. Hosted conversational commands require containment
and cannot fall back to uncontained host execution or control the owner's
terminal. Jev admission and current permission constraints still govern tool
actions. An attachment or a `survive` policy grants no additional tool authority.
See the [daemon composition](../src/runtime/hosted-session-composition.ts) and
[execution posture](../../../packages/engine/sdk/src/platform/hosted-sessions/exec-posture.ts).

## Inspect or end a session

The CLI supports these session operations:

```sh
goodvibes-daemon sessions list
goodvibes-daemon sessions list --all --json
goodvibes-daemon sessions kill <session-id>
```

`session` is an alias for `sessions`. Listing excludes terminated sessions unless
`--all` is supplied. Killing interrupts the turn and ends the selected session,
regardless of its attachments or detach policy. Killing an already terminated
session returns its retained record. A missing identifier is a usage error.

The [remote-target convention](commands-reference.md#the-remote-target-convention)
applies to `--host`, `--port`, and `--token`. Defaults use the configured control
plane and the local operator token. The CLI calls authenticated WebSocket verbs.
It has no session-create, attach, or stream subcommand.
See the [CLI implementation](../src/daemon/sessions-command.ts).

## Create, attach, and detach through the control plane

The [hosted method catalog](../../../packages/engine/sdk/src/platform/control-plane/method-catalog-hosted-sessions.ts)
declares these WebSocket verbs. They require authenticated access; listing declares
`read:sessions`, and the other verbs declare `write:sessions`.

| Method | Parameters | Result |
| --- | --- | --- |
| `sessions.hosted.create` | Required `workspaceRoot`. Optional `title`, `modelId`, `initialPrompt`, `detachPolicy`, `clientId`, and `originSurface`. | `{ session }` |
| `sessions.hosted.attach` | Required `sessionId` and `clientId`. Optional positive `leaseMs`. | `{ session, history }` |
| `sessions.hosted.detach` | Required `sessionId` and `clientId`. | `{ session }` after applying the detach policy |
| `sessions.hosted.kill` | Required `sessionId`. | `{ session }` with its termination reason |
| `sessions.hosted.list` | Optional `includeTerminated`. | `{ sessions }`, most recently updated first |

`workspaceRoot` must be an absolute, existing directory on the daemon's machine.
Creation resolves a supplied `modelId` against the host's live model registry.
Unknown or ambiguous models are refused. `clientId` attaches the creating client;
`originSurface` preserves the originating product's settings identity across
restarts. Creation submits `initialPrompt` without waiting for its turn to finish.
A creation response therefore does not prove successful model execution.

There are no dedicated REST routes for these five hosted verbs. The daemon also
accepts them through its generic authenticated
`POST /api/control-plane/methods/<method>/invoke` endpoint, with method parameters
inside the JSON envelope's `body` property. HTTP requests require an operator
credential or an authenticated user session, with the method's required access.
See the [HTTP dispatcher](../../../packages/engine/daemon-sdk/src/operator.ts),
[invocation handler](../../../packages/engine/daemon-sdk/src/control-routes.ts),
and [hosted handlers](../../../packages/engine/sdk/src/platform/control-plane/routes/hosted-sessions.ts).

`POST /api/sessions` creates a shared session record through the session broker.
It is a separate contract from `sessions.hosted.create` and does not take that
method's workspace and model parameters.

## Read history and live output

Attaching returns the retained conversation history. Subsequent text deltas,
turn transitions, usage, and tool events are available through authenticated
`GET /api/sessions/<session-id>/events` as server-sent events. This route requires
admin access. Set the variables below to the selected daemon, its operator
credential, and the returned session identifier:

```sh
curl --no-buffer \
	--header "Authorization: Bearer $OPERATOR_TOKEN" \
	"$DAEMON_URL/api/sessions/$SESSION_ID/events"
```

The stream filters events carrying another session's identifier. Events with no
session identifier can still be delivered. Closing the HTTP stream releases its
subscription. Stream closure is not an explicit `sessions.hosted.detach` call.
See [session event streaming](../../../packages/engine/sdk/src/platform/daemon/http/session-event-stream.ts).

Ordinary session message, steer, and follow-up HTTP contracts are defined in
[runtime session routes](../../../packages/engine/daemon-sdk/src/runtime-session-routes.ts).
A `202` conversation-message response means the input was persisted and routed;
it does not mean the turn completed. Native Agent and WebUI delivery uses the
separate [native hosted-turn protocol](../../../packages/engine/sdk/src/platform/control-plane/method-catalog-native-hosted-turn.ts),
which binds admitted source identity to its paired owner and requires fresh
operator authentication. A status read never grants delivery or retries an
ambiguous dispatch.

## Detach policy and leases

`kill` is the default. The last client detaching terminates the session with
`terminatedReason: "detached"`. With `survive`, the session remains reattachable
and an active turn can continue. Detaching one of several clients does not end
the session. A per-session override takes precedence over the live
`hostedSessions.detachPolicy` setting.

An attachment expires unless renewed. Calling `attach` again with the same
`clientId` renews it. The daemon also renews an expired attachment when a live
control-plane connection has that same client identifier. An unrelated SSE
subscription does not renew an arbitrary attachment. When the last lease lapses,
the sweep applies the session's detach policy.

The [configuration schema](../../../packages/engine/sdk/src/platform/config/schema-domain-hosted-sessions.ts)
defines these defaults:

| Setting | Default | Meaning |
| --- | --- | --- |
| `hostedSessions.detachPolicy` | `kill` | Policy when the last attachment leaves |
| `hostedSessions.attachmentTtlMs` | `600000` | Attachment lease, clamped to 30 seconds through 24 hours |
| `hostedSessions.maxSessions` | `8` | Maximum live sessions; terminated sessions do not count |
| `hostedSessions.maxMessagesPerSession` | `500` | Most recent messages persisted per session |
| `hostedSessions.terminatedRetentionMs` | `86400000` | Retention for terminated records |

The [attachment implementation](../../../packages/engine/sdk/src/platform/hosted-sessions/attachments.ts)
sweeps leases at intervals between 15 and 60 seconds. Expiry is applied by that
sweep, rather than exactly at the deadline.

## Restart and refusal behavior

The host persists bounded session state. A surviving session restores idle, with
no attached clients, and rebuilds its loop on attach or delivery. When the
retained conversation can be replayed, its transcript states that a
turn interrupted by restart did not finish. Malformed conversation state can
restore without that history and produces a warning. In-flight execution
does not resume from its previous instruction. A kill-policy session restores
terminated with reason `daemon-shutdown`. A failed loop rebuild records
`restart-unresumable`. Changing a session's effective policy before recovery
changes how recovery treats it.

Persistence failures are logged; a `survive` policy cannot guarantee recovery
when the state was not written. Inspect `status`, `terminatedReason`, and
`restoredFromDisk`, rather than treating a missing or interrupted turn as success.
The [manager](../../../packages/engine/sdk/src/platform/hosted-sessions/manager.ts)
and [store](../../../packages/engine/sdk/src/platform/hosted-sessions/store.ts)
own these transitions.

Hosted handlers distinguish `INVALID_ARGUMENT` with status 400,
`SESSION_NOT_FOUND` with 404, `HOSTED_SESSION_UNAVAILABLE` with 409, and
`HOSTED_SESSION_LIMIT_REACHED` with 429. Authentication failure is separate.
A host without hosted-session composition refuses the capability; its method
catalog alone does not prove that a session can run.

## Verification limits

The [daemon parity tests](../src/test/runtime/hosted-sessions-parity.test.ts)
cover composition, workspace trust, detach policy, and persisted recovery.
[Gateway tests](../src/test/daemon/gateway-hosted-session-failures.test.ts)
cover attached handlers and wire refusal shapes.
The [compiled-host proof](../scripts/hosted-session-proof.mjs) exercises
HTTP invocation, streaming, retained history, detach, kill, and restart with
synthetic model and judgment peers. It does not establish live-provider semantic
calibration or execution on another platform. The existence of these checks is
not a claim that they have passed in a particular checkout or release.
