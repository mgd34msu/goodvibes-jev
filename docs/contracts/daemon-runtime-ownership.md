# Daemon runtime ownership

The daemon composition owns the lifetimes it acquires. Construction, admission, publication, cancellation and cleanup are distinct boundaries: starting cleanup is not proof that work has drained. Consumers must await the relevant owner before releasing paths, replacing handlers or transferring leadership. This contract describes those boundaries and the validation techniques needed to preserve them. It does not grant source, account, device, payment or network authority.

## Runtime construction and dependency order

`createRuntimeServices` is an awaited factory over the actual base graph, canonical contract composition and outer handler boundary. It returns only after handlers are ready and persisted contracts have resumed. A construction failure closes acquired resources in reverse order; cleanup failure preserves both the startup error and cleanup errors. The runtime requires an explicit inbox factory; the production entrypoint supplies its production composition.

The SDK `createAgentGraph` composes and resumes one canonical runner. `createAgentExecutionGraph` builds execution collaborators so the daemon can supply its actual project-planning, fleet and ACP dependencies before composing that runner. Consumers receive the same runner, operator, hooks and fleet controls; a second legacy workstream engine or incompatible compatibility union is not a substitute.

Register ownership immediately after each constructor returns. All-required poller registration may replace only explicitly provisional entries; ordinary equal-label owners remain separate. Outer cleanup drains boot tasks, handler surfaces and distributed startup/writes before the base graph. The facade borrows the product graph, so product shutdown and one-shot callers own its close. Await `close()` before releasing paths or transferring ownership; the legacy `dispose()` wrapper only starts that same observed cleanup.

Provider discovery and the benchmark store initialize together. Selection awaits canonical catalog/benchmark preparation, and shutdown drains admitted discovery and benchmark refresh before owned paths are released. Validate an existing cached score through actual boot rather than only checking that the store was constructed.

Own the default `ProjectIndex` immediately. Disposal clears its delayed write timeout and flushes accepted entries; later mutations, suspended reroot and stale timer callbacks cannot reopen or write a disposed index. Register feature-settings/optimizer unsubscribe handles and an ownership-aware config-hook release. Hook attachment remains exclusive and last-attachment-wins, with distinct generations: an older release cannot detach a newer attachment of the same object or revive an older runtime. Borrowed configuration stays usable after shutdown and failed-start retry.

Own `ProcessManager` in the graph. Close fences new jobs and starts terminating owned children while admitted credential-name reads settle; those uncancellable reads keep close pending, and a post-read fence prevents late spawn. Owned POSIX jobs use fresh process groups and clean same-group descendants after leader exit before reporting done; do not retain a bare group ID for an arbitrarily later close. TERM/KILL escalation has finite bounds and reports unverifiable exit. `kill_on_timeout: false` jobs remain externally owned by default; `kill_on_close` makes ownership explicit. Preserve external jobs’ output/exit observation and pipes. Windows direct handles and descendants escaping the process group remain containment limits.

After stopping new checkpoint calls, `drain()` waits for admitted initialization and serialized Git work, removes subscriptions created by late initialization, and waits through queued follow-on work. Cleanup does not initialize an unused manager. Operation errors stay observable to their callers, and the cross-process lock must be absent when drain completes.

Validate the real product runtime and server on loopback: exercise inbox HTTP reads, draft and payment gateway reads, session contract snapshots and complete awaited shutdown. Follow a failed inbox constructor with successful reuse of the same owned root, and assert no intervals remain after either shutdown. Supply provider metadata and inbox adapters as explicit fixtures; these checks must make no live inference, mail, payment, SSH or cloud calls.

Implementation: [runtime factory](../../products/daemon/src/runtime/services.ts), [base graph](../../products/daemon/src/runtime/service-graph.ts), [provisional acquisition](../../products/daemon/src/runtime/acquisition.ts), and [disposal wiring](../../products/daemon/src/runtime/disposal-wiring.ts).

## Awaited disposal scopes

The shared existing `createDisposalScope` remains synchronous and unchanged.
`createAsyncDisposalScope` is exported through the same runtime
`disposal` subpath. It runs synchronous callbacks immediately, waits for newer
asynchronous owners before older dependencies, and continues after failures.
`close()` rejects with recorded failures after cleanup; `dispose()` is a safe
compatibility wrapper that logs failures and leaves them observable through
`close()` rather than generating unhandled rejections.

Late registration starts cleanup immediately and never reopens the scope. An
in-progress close includes late work, including further late work it registers.
If registration happens after a close settled, the late cleanup still starts
immediately and a subsequent close drains it. An already-settled promise cannot
cover registrations in the future. Reentrant synchronous disposal is supported;
a callback must not await the close of its own containing scope.

Validate reverse dependency ordering, idempotence, held children, aggregate failure, late registration, reentrant disposal and safe diagnostics. Keep the synchronous scope and awaited scope distinct in public consumer type fixtures and compiled-consumer smoke checks. Exercise the actual product cleanup registration, including graph-only pollers and handler owners, rather than a substitute list.

Implementation: [async disposal scope](../../packages/engine/sdk/src/platform/runtime/async-disposal.ts).

## Handler acquisition and shared handles

Handler modules consume declared public engine contracts for catalog, remote and payments; they must not invent a replacement gateway descriptor or protocol type. Context retains host-owned paths, credentials, config and logging, and all surface providers are required.

The registration order is routing, inbox, drafts, payments, remote. `registerDaemonHandlers` is async: each created surface is owned before its readiness is awaited, routing initialization finishes before inbox construction, and the aggregate is returned only after every surface is ready. Product root callers must await this factory. The returned payment inbox, remote service and dispatch adapter are the original objects supplied by their actual owners.

`close` awaits reverse cleanup. A failed startup closes the failing acquired surface and every older owner before rejecting. Cleanup continues after failures and preserves both the original startup failure and cleanup failures. Legacy `unregister` initiates the same observed close. A provider that rejects before returning a resource remains responsible for its own partial construction; the aggregate can own only returned handles.

Validate the real routing, cursor/poller/aggregation, encrypted-draft registration, payment composition and remote implementations. Cover gateway reads; held readiness; no premature later construction; failed final readiness; constructor and routing-readiness failure; same-catalog retry; cleanup continuing after error; identity of shared returned handles; and rejection of active payment veto windows on shutdown. Use synthetic providers/credentials and guarded temporary files, with no external service.

Implementation: [handler assembly](../../products/daemon/src/daemon/handlers/index.ts).

## Boot controller and notification ownership

`RuntimeServicesOptions.createBootOperations` is a synchronous construction seam supplying all six operations: memory fold, provider watch, webhook attachment, queue notifier attachment, configured-service synchronization and plugin initialization. It does not start them. Construct and own `DaemonBootController` before publication; start it only after the facade initializes memory. `bootTasks` is absent without this composition. Clean up factory failure with the acquired graph, and refuse publication if factory construction reenters graph shutdown.

The controller owns its start promise before invoking an operation. Repeated start calls share it. Close synchronously fences new steps, starts retirement of existing owners, then waits for admitted acquisition and a final owner drain. A notification owner is registered before attachment; if acquisition finishes after close, it is closed without being attached. Failed attachment retires the partial owner before later steps proceed. An uncancellable memory fold, credential read, attachment, or plugin initialization keeps close pending, with the active step visible in the snapshot. Cleanup failures remain failures after the remaining owners have been attempted.

Boot failure recognition compares only a private sentinel identity, so an arbitrary rejection value cannot execute a getter or prototype trap while the controller handles failure. Reporting is deliberately generic: it receives only the failed step, with no raw rejection or configuration values, and does not preserve detailed failure diagnostics. The failed step remains represented in the snapshot, and cleanup failures still reject close after the other owners are attempted. The reporting result is awaited and its synchronous or asynchronous rejection is contained; a held report remains owned by start/close instead of becoming a detached rejection or allowing shutdown to finish early.

Boot drains before handlers and base dependencies. Plugin close may be requested by both boot and the graph because that owner is idempotent; neither layer manufactures cancellation for arbitrary plugin background work. Plugin composition uses the actual gateway, channel, delivery and provider registries. Slash-command and ordinary-plugin-tool registration remain explicitly logged as unserved by this daemon registry, rather than presented as runnable.

Production boot must use the same webhook notifier as operator methods, a live metadata-only reader and awaitable queue/webhook close. A missing close method cannot become a detached subscription or an apparently successful empty step. The process host starts facade then boot controller, exposes actual degraded/pending status and awaits facade/controller/graph shutdown on termination. Inbound-mail expectation/housekeeping timers require explicit composition disposal ownership without changing ordinary supervisor stop/restart semantics.

`DeliveryQueue` permanently closes admission when disposed, clears queued
retries, and checks closure after an admitted transport or failure reading
settles. A stale timer callback cannot reopen the queue. Successful admitted
transports still report their actual success. A failure settling after shutdown
rejects with a value-free DeliveryError instead of scheduling a retry or creating
a misleading dead letter. Refused replay retains existing dead letters.

An admitted replay temporarily removes its prior row while it owns the attempt.
If that replay rejects without a settled outcome, including shutdown or an
unavailable failure reading, it restores the exact prior record once through
the same bounded FIFO policy. Successful replay and ordinary
terminal replacement keep their existing receipts and metrics. The entire replay,
including restoration, is registered before callbacks run and is drained by
close(). Concurrent batches skip rows another batch has already consumed.

The `close()` method performs that immediate shutdown and awaits admitted
attempts. Admission is registered before invoking the callback, including callbacks
that request close synchronously. The callback still owns its transport timeout
or cancellation: close does not claim to cancel an API that accepts no signal,
and remains pending if an admitted callback never settles. Delivery failures stay
observable through the original delivery promises. A callback must not await the
same owner's close promise while it is itself being drained.

`Notifier.dispose()` also detaches event subscriptions and prevents reattachment.
Its `close()` awaits complete admitted notifications and queue work. Closing between
two channels prevents the second send; closing one notifier preserves unrelated
subscribers. Tests use synthetic transports, controlled promises and captured
retry callbacks. No actual Slack or Discord messages, credentials, or provider
calls are involved.

Validation should hold acquisition across close, deliver late owners, fail attachment, reenter close during construction, hold memory folding/plugin initialization and failure reporting, aggregate cleanup failures, and retry with a fresh instance. Exercise an enabled temporary plugin through the actual daemon HTTP route, then ensure shutdown removes its runtime registration while preserving its enabled preference. A controlled omission of boot-owner registration should break graph cleanup assertions. Use controlled transport promises and captured retry callbacks to prove post-close retries stay fenced and replay restoration drains; never substitute a settling sleep for ownership.

Implementation: [boot controller](../../products/daemon/src/runtime/boot-tasks.ts), [production operations](../../products/daemon/src/runtime/boot-composition.ts), [delivery queue](../../packages/engine/sdk/src/platform/integrations/delivery.ts), and [notifier](../../packages/engine/sdk/src/platform/integrations/notifier.ts).

## Provider preload and background discovery

The host owns the runtime graph, then enters a fixed `provider preload`
phase. It awaits `providerRegistry.ready()`, checks its shutdown fence, loads
the cache through the public discovery loader, registers only a nonempty
snapshot, and checks the fence again before constructing any server. The roots
come from `runtime.homeDirectory` and `runtime.surfaceRoot` (currently `tui`),
not the daemon identity tier, workspace or ambient `HOME`.

Readiness means the established tolerant initial custom load has settled. It
does not attest that every custom configuration succeeded. It lets successfully
loaded custom providers retain their existing precedence over cached names in
the primary daemon registry. The shared loader supplies fresh structural records, filters invalid entries,
preserves functional URL bytes and uses fixed diagnostics; this caller adds no
parsing, route redaction or semantic secret guesses. An absent, empty or wholly
invalid cache does not erase already registered discoveries.

The host awaits admitted preload work during close. Shutdown while readiness is
held prevents later cache registration and server construction. Unexpected
registration failure, including partial mutation, fails startup with the fixed
phase diagnostic and joins owned graph cleanup. No catch-and-serve path or new
registry transaction is introduced. The base graph's existing provider metadata
drain also awaits initial readiness, covering acquisition failure before the
host can receive the graph. Provider watcher ownership is unchanged.

The hosted composition awaits each new floor's own tolerant initial custom load
before copying the daemon registry's discovery snapshot or admitting hosted
model selection. Successfully loaded custom providers therefore retain name
precedence in the floor as well as the daemon. Background discovery can supply a
new snapshot to later floors; no model fallback mutation or discovery-cache watcher
is added. Rewriting the cache does
not update the running daemon or its existing floors. A later explicit registry
change can affect a new floor; it is not broadcast into existing floors.

The asynchronous floor factory owns its acquired client graph until it returns a floor. Unexpected readiness/cache-copy failure disposes that graph and exposes only a fixed phase error. After publication, the shared pending-floor owner owns cleanup. Shutdown must await pending factories and late disposal without granting a lease or publishing a session; the product barrier neither duplicates that owner nor changes public factory types. Client-graph disposal retains its synchronous API. The shared create owner drains registration and initial persistence before writing shutdown state, including kill/survive parking and explicit-kill races.

Ordinary discovered providers confer no protected-source authority, Jev authority or hosted-fallback permission. Discovery does not establish a screened account, provision credentials, activate legacy IMAP or authorize service setup.

After custom readiness and cache preload, the host starts one owned canonical discovery `scan()` without blocking listener startup on its result. Nonempty results enter the server/new-floor registry and merge into the selected home/surface cache through canonical persistence. Empty or rejected scans do not clear the registry or rewrite the cache. Custom-provider precedence, selected models, existing floors and cache-removal policy remain unchanged.

The controller's close fences result application immediately, including a second
fence between registration and persistence for synchronous shutdown reentry.
It awaits accepted scan and persistence settlement before graph disposal. The
canonical scanner has no cancellation API: shutdown suppresses late application,
but does not abort network probes. Existing process shutdown deadlines remain
responsible for a scan that never settles. Rejected scan, registration or injected
persistence work receives a fixed diagnostic without inspecting the rejected
value. The canonical cache helper retains its own tolerant persistence behavior.

Validate selected-home cache choice using decoy roots and an authenticated loopback hosted create. The real floor should use its provider for an owned synthetic request without a test-only readiness wait or direct discovery registration. Cover absent/empty/invalid caches, custom-name precedence, same names in distinct homes, held custom load, shutdown before registration/server creation, partial-registration failure with held graph close, acquisition failure, concurrent HTTP creates, cache-copy failure and fresh retry. Hold actual registration/persistence across close and verify kill/survive records have no late creation publication. For discovery, observe listener readiness before scan settlement, provider-list HTTP and later floors, cache-backed restart and held scan/persistence drainage. Inject synthetic scans in ordinary and emitted subprocess fixtures; use fresh owned empty pricing caches.

Implementation: [daemon host](../../products/daemon/src/runtime/daemon-host.ts), [owned discovery](../../products/daemon/src/runtime/provider-discovery.ts), and [hosted floor](../../products/daemon/src/runtime/hosted-session-composition.ts).

## Plugin retirement and streamed callbacks

The daemon graph creates its PluginManager before publishing the runtime. Shutdown needs to retire the active instances without changing the operator's enabled, configuration, trust or quarantine state. Calling `disable()` is not a shutdown substitute because it persists an operator preference change.

`PluginManager.close()` permanently closes lifecycle and preference mutation admission, owns the complete previously admitted initialization/enable/disable/reload operations, and closes calls into every acquired plugin name. It then attempts each acquired instance's cleanup and rejects after all attempts if cleanup failed. Repeated close calls share the same result. An already admitted operator mutation may finish; close itself performs no state write.

The call tracker can close one plugin name when supplied by another owner. Unrelated names and independent trackers stay available. Reload's `resume()` cannot reopen a closed plugin. Captured callbacks from a retired instance also refuse after a later reload creates a new instance.

`shutdownStatus()` exposes mechanical progress while close is pending: open/closing/closed/failed state, pending lifecycle operations and instances, active named calls, and cleanup failure counts. A terminal host can report this evidence without treating a pending promise as completed shutdown.

Every loaded instance has a separate registration and callback lifetime. All registration families check it before acquiring resources. Asynchronous provider registration is tracked through its import and rechecks admission before registry publication; unload drains those registrations before deactivation and cleanup. Retained APIs cannot register resources after retirement. The asynchronous provider registration returns the promise its lifetime actually owns, avoiding a detached unhandled outer rejection when a plugin starts registration without awaiting it. Failed initialization closes the same registration lifetime and releases partial registrations. Normal public loader helpers retain their default best-effort cleanup behavior; the manager requests observable cleanup failures through the additive cleanup option.

Registered capabilities use receiver-preserving facades over the declared interfaces: LLM providers and nested batch operations; channel operations and returned agent tools; delivery strategies; memory, voice, media and search providers. Callback admission and settlement use the same instance and named call owners. Frozen objects and class private fields keep their receiver semantics. Declared members are own enumerable fields on a plain structural facade so registry spreads/normalization cannot drop methods or recover raw prototype callbacks. Getter-backed voice stream results preserve their declared fields while replacing only chunks. Provider and delivery cleanup checks the stored registered object identity before removing an entry, preserving a newer replacement and avoiding subscription-routed provider lookup. Channel cleanup passes an expected instance directly to storage-backed unregister, so feature-hidden registrations are removed without deleting a replacement.

Voice chunk iterators remain admitted through EOF, error, consumer return or throw, including concurrent pending iterator operations. Channel Response bodies remain admitted through completion or settled cancellation, preserving response metadata, byte-stream/BYOB readers and backpressure. Native Node regressions cover pooled Buffer copies, empty-chunk progress, concurrent read/cancel and iterator return; cancellation cannot release ownership while its actual callback remains held. Close does not consume streams eagerly or invent cancellation: an unconsumed stream or a noncooperating callback keeps close pending. An admitted stream can still be consumed or explicitly returned/cancelled to settle that work after admission closes. Additional iteration passes and new callback calls are refused once their owner closes.

The response returned to a native HTTP server is an actual Response, with metadata accessors on that instance. Real Bun loopback delivery checks status, headers, body and the resulting drain; disconnect checks hold source cancellation until it truly settles. A pending read does not operate on the controller after cancellation. An enable preference already saved by an admitted operator call survives shutdown interrupting activation and is honored by a fresh manager. Ordinary load failure still rolls back enable, while missing-plugin and already-closed refusals do not write preferences.

The original inbound Request signal also owns an unclaimed response. If disconnect precedes the handler's result, the adapter cancels that otherwise discarded body and awaits the actual source cancellation before returning. An unclaimed response is likewise cancelled if its request aborts after acquisition; an active reader retains its existing cancellation path. The abort subscription is removed when stream ownership settles. Native Bun early-disconnect and native Node late-response fixtures distinguish this abandoned response from an intentionally retained, unconsumed stream whose request is still live.

A HEAD request has no response body on the wire. Native Bun discards a handler's body without consuming or cancelling it, so the adapter explicitly awaits cancellation of that unused source before returning a native Response containing an already-closed, resource-free stream. Status, status text, metadata and declared headers, including an explicit representation content length, are retained. A null replacement body would make Bun incorrectly infer a zero representation length; the closed stream preserves the existing omission of an unknown length without reading source bytes, as allowed by [RFC 9110 sections 8.6 and 9.3.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.3.2). The native HEAD fixture holds the source cancellation and proves that neither the handler response nor shutdown completes early; it also verifies zero source pulls and exactly one cancellation. Native GET/HEAD comparisons check both explicit and omitted length. GET readers and disconnect handling retain their existing ownership paths.

Register provisional plugin ownership immediately after construction and place its final drain before runtime dependencies; handler shutdown precedes the graph. Lifecycle ownership applies to trusted plugin code. It is not a sandbox or a new capability policy. Callbacks own their cancellation/external resources: never-settling work keeps close pending, and resources outside registration/deactivation cannot be claimed released.

The controlled plugin fixtures use owned temporary modules, a real PluginManager and ToolRegistry, and synthetic registry/event adapters. They cover state preservation, admitted calls, held activation, close during reload/enable, retained APIs, provider registration, reentrant close, concurrent retirement, failed-start retry, error aggregation and unrelated subscribers/trackers. Additional capability fixtures cover real channel registry dispatch, nested tool/batch calls, private receivers, frozen sources, replacement identity, iterator return/concurrent next/EOF/error, Response body read/cancel/error/backpressure, and ignored registration rejection. The product test uses the actual composed runtime and awaits an admitted plugin call before requiring the runtime close to finish.

Selective omission probes fail on the expected behavioral assertions when removing only (1) product ownership registration, (2) retired-instance registration closure, (3) observable unload cleanup failures, or (4) manager lifecycle-operation drain. These probes do not alter the committed tests or relax their assertions.

Implementation: [plugin manager](../../packages/engine/sdk/src/platform/plugins/manager.ts), [loader](../../packages/engine/sdk/src/platform/plugins/loader.ts), [owned capabilities](../../packages/engine/sdk/src/platform/plugins/owned-capabilities.ts), and [product plugin composition](../../products/daemon/src/runtime/plugin-composition.ts).

## External protocol authority and owned drainage

The actual daemon graph wires ACP and MCP to its recorded judgment port,
real permission manager, current configuration and owned cancellation lifetime.
ACP retains the original prompt. MCP requires the actual pending caller's
source for risk-policy admission. Remote tool prose is evidence, not authority.
Missing source, unavailable readings, uncertainty and refusal do not use the
human approval broker. Exact caller facts alone can answer elicitation forms.

Outer shutdown immediately fences permission admission and begins ACP stop and
MCP disconnect before unrelated owners drain. The registry owns in-flight
negotiation as well as published transports. Removed/replaced configurations
cannot publish a late client, restore an old URL/policy, or escape shutdown
cleanup. Failed cleanup remains owned after its caller settles, blocks new
replacement, and is reported by shutdown. This grants no new network scope.

Each hosted ACP record owns one teardown promise, published before abort/unsubscribe callbacks can reenter shutdown. Cancel authority and pending permission scopes synchronously. Bound ACP cancellation to 250 ms, then SIGTERM and a 250 ms graceful-exit interval; escalate to SIGKILL if needed and await actual child exit with a 5-second failure ceiling. Retain and report timeout/rejected-exit failure on the record so dismissal or later stop cannot erase it. Release a terminated child only after observing exit.

Stop, failed initialization, concurrent stop, and daemon shutdown await this
same ownership. Terminal records cannot be dismissed while drainage is pending
or failed. The daemon drains every ACP child with `allSettled` before reporting
aggregate failure, so one failed child does not detach its siblings.

`stop()` waits for owned cleanup and rejects on cleanup failure; dismissal refuses pending or failed cleanup. This directly owned-child guarantee does not establish arbitrary descendant containment, successful cleanup despite an OS kill/exit failure, live-provider behavior or automatic MCP restart-timer scheduling.

Use local fake protocol peers and synthetic recorded judgments to validate late publication after config removal, replacement URL/policy preservation, and close waiting for cancelled pending-client cleanup. The fixture should wait for the real config watcher to consume an explicitly owned disk generation, with no guessed delay or watcher restart. For ACP, include a real peer ignoring SIGTERM, concurrent stop, failed handshake, pending negotiation, outer close and actual exit promises; prove escalation, signal failure retaining a live child, rejected exit observation, repeat-stop failure retention and synchronous abort reentry closing permission scope/signalling once. Force-kill and await fixture peers in cleanup even for negative controls.

Implementation: [ACP host](../../packages/engine/sdk/src/platform/acp/host.ts), [MCP registry](../../packages/engine/sdk/src/platform/mcp/registry.ts), and [daemon base graph](../../products/daemon/src/runtime/service-graph.ts).

## Config readiness and workspace trust

Before readiness, boot drains already-visible config disk generations, including edits arriving during migration, through the ordinary synchronous poll exposed as `ConfigManager.flushConfigFileChanges()` / `ConfigFileWatchHandle.poll()`. Do not suppress same-value or ABA invalidation. A first-operation regression should hold an MCP judgment across the first real poll and pass without startup sleeps or watcher restarts. Tests making a later setup write drain only their own write.

Every owner-present MCP call, including deterministic allow/allow-all, requires
canonical recorded admission of its authentic originating source. Server policy
is an additional bound. Missing source is refused; peer tool text cannot supply
it. Existing standalone no-owner MCP callers retain their legacy contract.

ACP spawn checks the daemon-origin authority and actual requested cwd. MCP
stdio checks the actual inherited cwd or sandbox registry workspace before any
process probe, and the returned process cwd before launch. Physical workspace
aliases share the daemon/hosted-floor trust manager. Origin and target realpaths,
capability identities and live revisions are retained through asynchronous
preparation, final process start, negotiation publication, permission responses,
and tool continuations. A host with no capability fails closed; explicit null is
reserved for a composition with no separate workspace policy.

MCP automatic restart uses the same final `beforeProcessStart` guard. Validate a real local peer negotiation, dispose it, then invoke that exact boundary under revoked trust and require zero additional peer spawns. This tests the process boundary, not restart-timer scheduling. Explicit restrictions remain restrictions and undecided trust stays undecided after an admitted action; there is no human fallback or persisted trust grant.

The public capability boundary includes optional `ExternalPermissionHost.workspaceTrust`, `workspaceRoot`, trusted `workspaceTrustFor`, and `SandboxSessionRegistry.getWorkspaceRoot()`. Missing trust capability is not the explicit-null no-separate-policy composition. Preserve origin/target realpath, capability identity and live revision through asynchronous preparation and each effect boundary.

Product protocol fixtures obtain authentic source custody through public core `executeToolCalls` and a `ToolRegistry` bound to the actual daemon permission manager. A genuine recorded native admission precedes the protocol body; product-owned synthetic readings do not mint private ambient authority or import engine-private helpers. Cover initial/target/physical-alias/ABA/continuation trust, same-value external config writes and in-process invalidation. Normalize spawn arguments and match the configured agent/peer command identity so background checkpoint Git probes are not mistaken for ACP/MCP spawns; do not fix counters with sleeps or blanket exclusions.

Local synthetic peers demonstrate bounded authority and lifetime properties. They do not establish live-provider/native-artifact acceptance, universal permission-path completion, automatic restart timing, or atomic protection against a filesystem change inside the OS spawn syscall.

Implementation: [boot config guarantees](../../packages/engine/sdk/src/platform/daemon/facade-boot-guarantees.ts), [config manager](../../packages/engine/sdk/src/platform/config/manager.ts), and [workspace trust composition](../../products/daemon/src/runtime/workspace-trust-composition.ts).

## Persistent configuration and secret ownership

Preserve the historical `tui` storage root, daemon-owned config migration, explicit checkpoint settings/registration enum, exact schema-key guard, secret-backed write scopes and literal-reference wrapper. Product adapters use declared config/utils imports. `DaemonCredentialStore` accepts the structural get/set secret-store subset, avoiding engine-to-product imports; config-key derivation delegates to canonical `daemonSecretKeyFor`, and replication-drift tests pin that same platform rule.

Draft encryption refuses and preserves malformed existing keys; decryption never creates a key. Explicit encryption may create absent key material only through its admitted ownership contract. Errors must contain neither key material nor draft text. An instance shares its pending key operation; failed reads/writes are not permanently cached, and retries reread storage even if a failed write actually persisted. Preserve AES-256-GCM layout/authentication and fresh IVs.

Draft first creation uses `SecretsManager.getOrCreateDaemonSecret` under strict
cross-process ownership. Actual secure/plaintext target paths are locked in
stable order, including policy-eligible fallback. Other writes/deletes and legacy
whole-file migration use the same target namespaces; migration re-reads after
acquisition. Policy changes during acquisition refuse. User/project mutations
do not depend on an unrelated daemon directory. Canonical base64 key material is
required; malformed material remains preserved and decrypt never creates a key.
Stores without atomic creation capability may read an existing valid key but
cannot create new cipher material.

Credential composition passes supplied global/workspace homes and optional daemon-home override to the real secret manager, shares that manager with the step-up verifier, and reads pairing metadata only at the injected path. Mail retains public surface-to-email config/secret adapters, node transport and the neutral sender-claim describer; preserve explicit TLS/STARTTLS, distinct missing-configuration/missing-credential refusals and literal `commandAuthority: 'none'`.

Retain original config/schema/replication assertions for encrypted local storage, daemon-tier default/clear behavior, reference/bare-name lookup and cross-surface resolution. Use dummy strings under guarded owned temporary homes; raw unguarded fixture invocation must refuse. Cover primitive/bounds validation and explicit checkpoint choices, migration receipts/idempotence/failure preservation, and literal secret wrappers with intercepted resolution rather than provider CLI calls. Cipher checks include missing/malformed keys, authenticated round-trip/corruption, concurrency and rereading after uncertain writes. Include a compiled Node public credential/cipher round-trip. Cross-process creator tests must reopen decryption and include unrelated daemon writes/shared-user-tier writers. These tests do not touch real credential homes, pair devices, enroll access, alter security settings or activate external services.

Implementation: [credential/cipher owner](../../packages/engine/sdk/src/platform/config/daemon-credential-store.ts), [atomic secret namespace](../../packages/engine/sdk/src/platform/config/secrets.ts), [product config adapters](../../products/daemon/src/config/secrets.ts), [checkpoint settings](../../products/daemon/src/config/checkpoint-settings.ts), [credential composition](../../products/daemon/src/runtime/credential-composition.ts), and [mail composition](../../products/daemon/src/runtime/mail-composition.ts).

## Handler SQLite and draft persistence

- Existing `.goodvibes/tui/operator/<fileName>` databases open in place
- `init`, `run`, `all`, `get`, `transaction`, `save`, `close` and `dbPath` retain
  their call shapes; the public options type is `HandlerSqliteStoreOptions`
- One database per concern, SQLite parameter binding, atomic temp-and-rename
  save, transaction rollback and explicit missing-row behavior
- Unreadable images are quarantined with a warning; retention is 14 days and
  at most three copies per store, with disclosed reaping
- The SDK's distinct `SQLiteStore` retains its existing migrations, snapshots,
  versioning and batching. Only its internal memoized sql.js loader is shared,
  avoiding re-entrant WASM initialization

- A failed quarantine makes persistence refuse rather than overwrite the only
  recoverable copy. The fresh in-memory store remains available
- `PRAGMA quick_check` validates existing database bytes independently from the
  schema. A caller's invalid schema neither quarantines healthy data nor leaves
  a half-initialized store, and initialization can be retried
- Save snapshots are captured before yielding, serialized per exact store path
  within this process, and independent of subsequent writes or close. Unique
  temp paths alone did not prevent an older rename from winning last
- A failed atomic rename preserves the prior database, cleans its scratch file,
  and leaves the save queue usable for the next attempt
- New quarantine names include a UUID and a quarantine timestamp. A same-clock
  quarantine does not reuse a prior name, and a damaged file's old modification
  time cannot immediately expire its new salvage copy. Historical names retain
  the legacy mtime-based retention convention

The queue is not a multi-process transaction lock or a merge of separate
instances' snapshots. Callers still own logical write coordination and must
await saves before exiting. Validate with owned fixture databases, without a live provider or user database.

SQLite magic-byte equality and `quick_check` read the database format and the
database engine's verdict. The new quarantine name parser reads only the
program's own filename grammar. Retention compares timestamps and a count to
the existing explicit limits. Save queues and initialization flags track
execution state. None interprets prose meaning; no new judgment battery or
heuristic fallback is introduced.

Validate recovery and lifecycle independently: failed quarantine, healthy data with invalid schema, initialization retry, snapshots captured before yields, same-path save ordering, rename failure/scratch cleanup, same-clock quarantine uniqueness, timestamp-based retention and shared-loader reentrancy. Basic transaction and loader success alone do not prove these failure paths.

The host mirror retains `.goodvibes/tui/operator/drafts.sqlite`, schema, caller-supplied modification timestamps, full-snapshot optional-field clearing, first creation metadata and send-pipeline metadata. Body and webhook are encrypted through the existing daemon cipher port. Wire records contain a 12-character SHA-256 body digest, never the body; webhook presence is always redacted. The four canonical `channels.drafts.*` descriptors, access metadata, confirmation AND explicit-user-request checks, input bounds and refusal wording remain intact. No new semantic guess or model call is introduced.

Shared payments/drafts registration and confirmation rules live in `control-plane/host-handlers.ts`. The historical payments path re-exports the same functions/error alias. `GatewayVerbError` stays canonical with its code/status/message; do not create a competing error implementation or silently change confirmation policy.

The draft store owns each admitted input snapshot and queues upserts in call order. Awaitable close stops admission and drains initialization, encryption and persistence before releasing SQLite. Validate close during encryption, initialization trying to reopen after close, mutable input during encryption and concurrent same-ID creation. Direct callers must await mutations before synchronous read/delete and explicitly save direct upserts; no automatic persistence is implied.

The registrar keeps its callable legacy teardown and provides `close(): Promise<void>`. It stops handlers immediately, drains complete accepted handlers through persistence, and closes only a store it constructed. Mutating handlers are serialized so a later delete cannot be undone by an earlier save still encrypting. Failed initialization can retry. First close restores those descriptors handler-less, and repeated old teardown cannot erase replacement handlers. A replacement must wait for the old close to complete. Cleanup failures remain observable to awaiters and produce value-free diagnostics for legacy callers.

Preserve original store/registration assertions with public imports, owned temporary storage and awaited cleanup. Additional checks cover delayed encryption/initialization/close, input capture, same-ID order, failed-encryption isolation, accepted-save persistence, borrowed ownership, descriptor reuse, retry, save/delete order and cleanup-failure reporting. Use fake ciphers and memory-only key stores, never real credentials or live channels.

The canonical engine platform/state implementation is shared with non-daemon consumers; retain [original recovery assertions](../../packages/engine/test/daemon-handler-sqlite-recovery.test.ts) alongside lifecycle checks.

Implementation: [handler SQLite store](../../packages/engine/sdk/src/platform/state/daemon-handler-sqlite-store.ts), [draft store](../../packages/engine/sdk/src/platform/channels/host-drafts/draft-store.ts), and [shared host handlers](../../packages/engine/sdk/src/platform/control-plane/host-handlers.ts).

## Payment reply lifetime

Payment composition keeps surface-scoped card metadata, purchase/budget/owner-approval and in-flight checkout files. Card material uses the existing daemon-tier secret port. The browser checkout seam remains a getter, with no substitute browser. Merchant assessment uses the registered `createJevMerchantJudge` reading.

`createPaymentsServices` constructs one actual `PaymentReplyInbox`, supplies it to `channelBackedPaymentNotifier`, and returns it as `paymentReplies`. The root must pass that exact object to `DaemonConfig.paymentReplies`. The facade passes the borrowed object through its collaborators into `DaemonSurfaceActionHelper`, whose established ingress policy authenticates owner/channel before offering replies. The product root is the shutdown owner. Listener restart must not close this borrowed inbox.

Stop ingress and await `PaymentsServices.close()` before releasing the graph or registering replacement handlers on the catalog. The compatibility `unregister()` initiates that same close. Close stops handler and reply admissions, rejects open waits, and drains the registration promise and accepted reply readings. It does not claim to drain browser/gateway work already admitted: the full root must await those operations separately.

`null` from a payment wait means genuine deadline silence, which may permit a veto purchase. Shutdown therefore rejects with `PaymentReplyInboxClosedError`; it must never manufacture silence, acknowledgment or approval. Rejection is safely observed for legacy void callers without changing the promise seen by awaiting callers. Accepted readings are registered before invoking the port, so a reentrant close cannot miss them. Failed readings remain observable to their callers and late answers cannot reopen a closed window.

Validate approval/veto rejection, genuine elapsed silence, accepted/failed reading drain, late/reentrant shutdown, refused new admission and ignored legacy waits. In actual `runCheckout`, close during a delivered veto notice must abort before card read, page fill or submit and leave the unresolved journal record available to recovery. Exercise the real catalog/stores, live owner limits/leadership, close during registration, same-catalog reuse only after awaited close, and actual checkout through the composed notifier and returned inbox to an owner veto. Use dummy memory-only card material, owned metadata paths, recorded judgment and recording channel/browser boundaries; never contact a real merchant/account/payment.

Keep the facade work-proposal store’s established policy and initialization warning when moving its construction into a helper.

Implementation: [payment composition](../../products/daemon/src/runtime/payments-composition.ts).

## Device source authority and retained captures

The daemon selects the recorded autonomous device owner. Missing original source or recorded port refuses. Explicit legacy low-level confirmation injection is only a library-compatibility path. Durable grants are evidence: their publication requires a separate act, and every exact dispatch requires another current act. At actual delivery, the queue consumes single-use admission bound to token, exact payload and peer lifecycle; executable ownership is never serialized. Guarded restart, stale pulls, timeout, cancellation and lease replay refuse.

Device ownership binds the already-gated node and policy, original source revision, exact clamped timeout, config invalidation, observed peer generation/pending mutation, and grant ledger incarnation/content plus local revoke/sweep intent. Pending mutations are visible before their first await, so a request cannot start on old bytes after revocation has begun.

Grant persistence guards before atomic publication. The store mints an authentic result-object receipt immediately after publication, before directory fsync awaits; it validates the entire written snapshot and records its observed revision. Returning from an async grant write cannot silently adopt an intervening external rewrite. Capture ownership survives returned bytes through index publication; cancelled publication removes unindexed bytes. Refused dispatch never records successful grant usage.

The canonical hosted floor borrows the actual root device runtime and registers its existing phone tool. `device-hosted-ownership.test.ts` exercises the real product floor, session registry, canonical public tool executor, original source, recorded native/device decisions and real synthetic peer queue. It never creates an external-operation scope itself. It covers successful retained capture, turn cancellation, actual disconnect/reconnect ABA and direct registry refusal. Direct authenticated HTTP/catalog callers without original host source remain refused; reason prose is not authority.

Filesystem incarnation/content observation is a bounded local observation, not universal cross-process ABA prevention or cross-process mutual exclusion. No live devices, provider calls, real secrets or external publication are used.

Gateway validation preserves all seven descriptors/handlers and paired node ID/label; exact capability/reason/node entering the recorded reading; exact capability sent to the synthetic peer; a once receipt without a human question; truthful `denied-by-jev` refusal with no transport; actual media type, 24-hour retention, artifact ID/count/byte length and byte-for-byte readback; durable grant create/list/reuse/revoke/renewed selection with fresh dispatch readings; truthful `jev:device` grant actor and `daemon:phone-tool` transport actor; and deterministic missing-input/absent-node refusal before judgment or dispatch.

Exercise device posture through real ConfigManager, product composition and grant/capture/housekeeping stores. Cover off/honor-grants/ask-every-time; every-capability/standard-only/never grant offers; configured deadlines reaching recorded policy, dispatcher wait and payload; coarse-only/ask-precise/precise-grantable location; clipboard off/ask-only/grantable; short/default capture expiry; count cap removing oldest bytes; actual periodic sweep/cadence; grant expiry and per-node caps; audit retention independent of live grants; live next-request settings; real phone registry/catalog and off refusal; and root-exposed live policy/stores/bound handlers. Pairing-node cap belongs to pairing rather than these dispatch proofs. Pin the eleven governed posture keys and compare their union with explicitly explained exclusions against every `device.*` key in `CONFIG_SCHEMA`: no schema key may be unaccounted for, and every pinned key must still exist in the schema. Keep `device.nodes.maxPaired` explicitly attributed to pairing validation rather than claiming dispatch coverage.

`grantEvaluations` in these tests is a filter over actual recorded requests where purpose is dispatch and no durable grant exists. It measures whether the corresponding host grant continuation was considered. It is not a fabricated human-prompt transcript or a replacement for current dispatch admission.

Device regression readings must include the required act evidence and use the correct log disposer. Include removed-ledger and unchanged-content ledger-rewrite probes so an async grant result cannot adopt intervening storage changes.

Public-boundary fixtures use existing SDK `executeToolCalls`, permissions, config, tools and runtime/security surfaces. Their product-owned synthetic gate reader supplies external transport answers only. Obtain original-source custody through real PermissionManager, PolicyRuntimeState, ConfigManager, ToolRegistry and recorded native admission before entering the synthetic body; do not mint or set private ambient authority. Each direct-service fixture owns native recorded-runtime installation and release. Turn cancellation propagates the native executor AbortError while preserving zero-dispatch/zero-capture assertions; cancellation must not be swallowed or converted to permission. Keep the actual hosted-phone proof as production-caller evidence.

Implementation: [device composition](../../products/daemon/src/runtime/device-posture-composition.ts), [device grants](../../packages/engine/sdk/src/platform/devices/device-grants.ts), [capture artifacts](../../packages/engine/sdk/src/platform/devices/device-capture-artifacts.ts), and [device autonomous owner](../../packages/engine/sdk/src/platform/devices/device-autonomous.ts).

## Runtime leaf compatibility

Fleet composition live-re-exports the canonical terminal-shell `createFleetServices` implementation and type instead of copying pricing/observation rules. Tests pin identity and exercise the real archive-aware registry using injected empty managers/timers and a mocked observed source before opt-in queries. Canonical contract-runner inputs replace legacy WRFC inputs. Runtime-barrel exports remain live, avoiding module-scope lazy-namespace reads. Export the actual `ContractEvent` and `GateEvent` types; do not alias retired `OrchestrationEvent`, `WorkflowEvent` or `PermissionEvent` to incompatible unions. A consumer type fixture verifies identities and rejects retired names.

- The browser holder exposes the current injected seam, stops returning it on
  clear, and can accept a later explicitly supplied seam. Tests invoke no browser,
  checkout driver, approval-arm operation or payment operation.
- Conversation rewind preserves recorded message-count boundaries, clamping,
  unavailable-session reporting, actual truncation, reversible snapshots and
  registration/unregistration. Fixtures hold only local in-memory dummy messages.

The device leaf installs the seven actual gateway handlers and reads changed owner policy at call time; construction must not create state, start housekeeping or call a device/approval transport. Trigger composition uses a live enable reader, historical scoped store and existing process host. A stored condition definition is not evidence it was polled/executed. Fleet wiring uses the canonical snapshot bridge and reads freshness from current session records. Memory-pressure notices preserve configured delivery, local-only reporting, unrelated-event filtering, failed delivery and unsubscribe.

- Checkpoint reads retain the legacy read-only fallback and shared-path
  precedence. Malformed/wrong-version stores confer no eligibility. Only the
  explicit boolean grant covers a workspace; worktree inheritance requires
  the supplied git relationship. Every read observes the current store.
- Real checkpoint manager fixtures exercise ineligible automatic/manual
  refusal, registration changes, actual scoped snapshots, session attribution,
  existing-checkpoint reads after unregistering and the owner's explicit
  guarded-workspace setting. Git state is created only inside the runner-owned
  fixture workspace, never in a user project.

Fleet fixtures use the actual authenticated principal invocation context and singular participant field, not a stale unauthenticated setup.

Memory governance validates a real tier, positive budget, ordered thresholds, both actual cache adapters in registration/snapshots, all three pausable jobs and no paused jobs at rest. Fleet Web Push preserves encrypted delivery, title/body/deep link and attached-session suppression; an unattended sibling and stale/unknown presence still deliver. Validate using real registry ticks, product-installed bus bridge, synthetic unactivated store records, loopback delivery and receiver decryption, including first-snapshot seeding and one blocked transition. This does not prove business-contract execution/resume or human tool-permission waiting.

Component checks are not substitutes for actual gateway rewind, full device/fleet-push or notification source-wiring suites. Validate asynchronous services at the complete root and retain existing-checkpoint reads after unregister, session attribution and the explicit guarded-workspace setting. Use local dummy messages, owned Git workspaces and in-memory delivery; no host process inventory/steering, real device/grant provisioning, webhook or external provider call is implied.

Implementation: [runtime barrel](../../products/daemon/src/runtime/index.ts), [fleet adapter](../../products/daemon/src/runtime/fleet-services.ts), [checkpoint eligibility](../../products/daemon/src/runtime/trust/checkpoint-eligibility.ts), and [workspace checkpoints](../../products/daemon/src/runtime/workspace-checkpointing.ts).

## Production intake and selected transport

The shipped entrypoint supplies `createProductionDaemonRuntime()` to `runDaemonCli`, which enters `runConfiguredDaemonCli` and the existing `createDaemonHost` owner. Preserve external-agent observation, canonical host power and wake-model boot provisioning, selected-home authentication and the captured ordinary-Bun resolver.

Production composition always represents Slack, Discord and email in one canonical composite inbox registration. A genuinely absent member is explicitly unconfigured/nonpolling; do not manufacture adapter success, sync timestamp, cursor, persistent store, account identity or screened projection. Establish absence through local literal credential inspection: unreadable storage, reference-backed/unsupported material or missing inspection capability refuses, rather than turning a nullable read failure into absence. No old account mirror becomes visible merely because credentials are absent.

Each read rechecks absence. Config/credential invalidation fences a read across
its generation; an unrelated invalidation may be revalidated by a later read.
A source that becomes configured cannot keep returning an unconfigured snapshot.
Sources close admission, detach subscriptions and drain held read leases before
retirement. Canonical multi-owner acquisition supplies rollback and one inbox
registration. Configured sources without a trusted account owner fail startup.

Trusted embedders supply explicit account and screening capabilities through `createProductionDaemonRuntime` member options. Preserve the real source constructors’ account, cluster, storage and protected-read fences; omitted members are admitted only when genuinely unconfigured. Current composition has explicit Slack, email and Discord constructors. The presence of a constructor is not permission to guess a Discord catalog, account membership or historical message coverage.

The `screening` value is the existing `ProtectedSourceOwnerOptions` contract.
It needs a generation-scoped local authority owner/revision, a live abort signal
and synchronous revocation check, two literal-loopback service endpoints (a
proposal model and compatible `jev-1.13.0` judgment), and established
`ephemeral-no-log` retention for both services. Slack additionally needs the
expected workspace and self account; email needs the expected TLS endpoint,
account and mailbox. A trusted process owner must bind those services and
accounts before constructing the capability. Source text, configuration strings,
a remote Jev URL, endpoint reachability or a recent-channel cache cannot grant it.

A persisted configuration, hosted judgment setting, reachable endpoint or source-text assertion is not a managed local-service identity, no-log retention proof or source permission. Deployment admission requires operator-approved source/account scope and an approved compatible local Jev/proposal runtime. Do not substitute a regex mapper, hosted raw-text fallback or unauthorised live-provider activation.

Status and sessions WSS upgrades use the selected configuration's canonical TLS
policy and relative CA root, without installing a global transport. Cluster HTTP
also uses selected-owned fetch. Existing HTTPS ownership remains intact. The
emitted caller test matrix covers custom, bundled-plus-custom and bundled trust,
wrong/missing CA, selected homes and overlapping/global owners.

Validate production membership, refusal and revocation, emitted-entrypoint startup/shutdown, selected-command HTTPS/WSS, selected homes and overlapping/global transport owners. Native packaging verification should exercise startup/shutdown from relocated source-free artifacts. The presence of verifier code is not an execution receipt, and source-level tests cannot establish live calibration, configured deployment onboarding, all native platforms, authenticated update artifacts, service adoption or publication.

Implementation: [production runtime](../../products/daemon/src/cli/production-runtime.ts), [production inbox](../../products/daemon/src/runtime/production-inbox-composition.ts), and [daemon host](../../products/daemon/src/runtime/daemon-host.ts).

## Owned temporary cleanup

`makeProjectTempDir` requires `GOODVIBES_TEST_OWNED_TMP_ROOT` and the official runner, allocates beneath that root and refuses raw invocation. The owned-child lifecycle must reap its admitted child/process group before removing the identity-pinned parent. Arbitrary child-written deletion paths are not accepted ownership evidence.

After an optional preservation inspector, revalidate candidates before deletion. Regression cases must prove replacements, newly retained evidence, a newly live owner and a refreshed directory survive. The unchanged stale control remains reclaimable. The sweep repeats full admission, compares the original device/inode and checks age again immediately before deletion. This closes the deterministic inspector-reentrancy cases and narrows a replacement window; it does not claim atomic safety against an adversarial filesystem change between the final check and rmSync.

Cover both current owned prefixes; missing, malformed, identity-mismatched and newly live ownership records fail closed after inspection. A throwing inspector preserves its candidate. Validate replacement, newly retained evidence, refreshed directories and an unchanged reclaimable stale control, with baseline negative controls and isolated official runner checks against the final combined source.

Current dead-owned-run evidence cannot establish ownership of historical pre-runner orphans or production/external-editor scratch. The historical one-hour shared `.test-tmp` and four-hour OS-temp sweep across 252 enumerated prefixes is not a deletion authorization. Supporting those paths requires a bounded retirement policy or separately authorized migration using trustworthy ownership; prefix-only recursive deletion must not be reinstated or credited.

Implementation: [canonical sweep](../../packages/engine/toolchain/src/test-runner/stale-tmp-sweep.ts).

## Validation boundaries

Run focused validation through the repository’s official guarded runner from its absolute repository cwd in owned temporary roots. When compilation is required, use the shared heavy-compiler lock. Keep original behavioral assertions, public-package consumer boundaries and failure receipts. Prove ownership with controlled held operations, actual returned handles and real local subprocess exit promises; component success, a source inventory or historical test counts do not prove complete root drainage. Controlled omission/negative probes must isolate the relevant owner and must not relax production assertions or timeouts.

Local/synthetic fixtures are deliberately bounded. They do not attest live inference, account access, credentials, mail/payment/SSH/cloud service behavior, device access, native/platform deployment, whole-product parity or live judgment calibration. Re-run affected integration/type/API/architecture checks, judgment lint, zero-any, credential-scope and whitespace checks, and normal commit hooks on the actual combined source when those changes are integrated; prior or reconstructed receipts are not current qualification. Compiler declaration regeneration and dependency order matter when public exports change.

See [configuration](../../products/daemon/docs/configuration.md), [hosted sessions](../../products/daemon/docs/hosted-sessions.md) and [testing and validation](../../products/daemon/docs/testing-and-validation.md) for operator-facing behavior. Historical reconstruction, source pins and per-checkpoint receipts are preserved with the existing [daemon project owner](https://linear.app/the-artificery/issue/TA-18/port-daemon-composition-and-remote-cluster-infrastructure); their original THE labels remain historical identifiers.
