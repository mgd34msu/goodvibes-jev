# Gate input and exec admission

Gate reading, permission admission, process admission and process lifetime are separate boundaries. Complete owned evidence does not itself grant autonomous authority. Registered protected-input projection has its own [contract](protected-tool-input-projection.md).

## Complete immutable reading input

A judgment about a prefix must never be reused as if it covered a complete command. Gate requests must use owned complete strings, including nested arguments; borrowed command arguments must not be reread after asynchronous readings to associate a verdict with a different command.

Keep complete strings in the gate's owned JSON projection and freeze that projection. Preserve whole-input privacy inspection and typed input-size, depth and node limits. Unsupported input is refused before a request, never shortened into an apparently acceptable action. The [local privacy floor](../../packages/engine/sdk/src/platform/gate/judgment-input.ts) remains in force; complete evidence is not privacy clearance.

Capture reading options, cancellation signal and command association once. Publish a single-command catastrophic cache entry only for the immutable command actually sent to Jev, after checking cancellation. A batch verdict does not become per-command entries. Preserve the exec-time AST guard and recorded-verdict semantics.

## Gate validation

[packages/engine/test/gate-input-binding.test.ts](../../packages/engine/test/gate-input-binding.test.ts) must cover long-string suffixes in every gate battery and an uncached exec-time reading, real AST-guard refusal, the short-command cache control, argument/options mutation while requests settle, batch isolation, late cancellation, input bounds and credential refusal. [test/gate.test.ts](../../packages/engine/test/gate.test.ts) checks complete immutable string content. Use synthetic payloads and intercepted requests; these regressions need neither shell-payload execution nor a live provider.

The global catastrophic cache is bounded and keyed by command text. It is not a complete action/authority/scope receipt. Autonomous outcome selection, live authority revalidation, full-context receipt binding and atomic execution require their own consumers and proofs. This reading boundary neither makes a legacy permission flow autonomous nor converts uncertainty into approval.

## Cancellation during exec admission

A cancelled call must not wait indefinitely for a catastrophic, owner-terminal or credential-name reading and then launch a command on its late result. Exercise deferred allow and deny outcomes with registered offline readings and intercepted launch boundaries.

The caller signal is captured for the invocation. Catastrophic, owner-terminal and retry readings receive it, race unresponsive readers and reject late results before recording an execution decision. Exec checks cancellation before file operations and command admission, cancels retry delays and returns a typed cancelled result. Calls without a signal retain their optional-signal API. Captured authority may contribute its own lifecycle signal; replacing the caller's options cannot replace the captured admission signal.

## Admission versus detached lifetime

ProcessManager's optional `SpawnOptions.signal` applies only to admission. An
aborted caller settles immediately while the underlying shared credential read
remains owned by the manager and is drained by `close()`. The captured signal is
checked after that read and immediately before `Bun.spawn`, after caller-owned
environment and stdin accessors have run. Mutating the original options object
cannot replace the signal. Successful spawn removes the abort listener; later
caller cancellation does not change the detached process lifetime, close
ownership or descendant cleanup policy.

## Cancellation validation

Cover deferred allow/deny, exact signal forwarding, typed cancellation after execution-options mutation, pending retry cancellation, pre-aborted file operations, credential-await cancellation, replaced/removed admission options, reentrant environment/stdin cancellation, retained shutdown drain and post-spawn lifetime. Preserve process-close, process-group cleanup, timeout, retry and no-retry controls. Use explicit offline judgment responses and intercept launch for incident reproductions.

## Serialized cancellation compatibility

Early admission cancellation exposes both the top-level typed `cancelled: true` field and `JSON.parse(result.output).cancelled`. It must not read already-aborted arguments or invent a command, exit status, timeout or retry count before those facts exist. Pending-policy, pre-file-operation and mutated-options controls must assert both representations. Preserve unchanged compatibility and detached-lifetime assertions.

## Current continuation boundaries

The exec `until` path receives the caller signal and combines it with its deadline. It checks signal, owner currentness and the pinned request around regex work, spawn, stream reads and result delivery, then stops/drains the process and streams in cleanup. This is a separate running-command lifetime from detached `ProcessManager` admission.

Admission fixtures alone do not qualify every foreground sandbox, credential, interactive-prelaunch or in-progress multi-file boundary; those paths require their own current-source validation. Cancellation must not weaken permission, containment or owner-terminal policy.

Source and focused validation: [gate readings and cache](../../packages/engine/sdk/src/platform/gate/reading.ts), [exec runtime](../../packages/engine/sdk/src/platform/tools/exec/runtime.ts), [ProcessManager](../../packages/engine/sdk/src/platform/tools/shared/process-manager.ts), [test/process-manager-admission-cancellation.test.ts](../../packages/engine/test/process-manager-admission-cancellation.test.ts), [test/exec-tool-result-shape.test.ts](../../packages/engine/test/exec-tool-result-shape.test.ts) and [test/process-manager-close.test.ts](../../packages/engine/test/process-manager-close.test.ts).
