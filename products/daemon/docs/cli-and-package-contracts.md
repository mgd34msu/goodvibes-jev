# Daemon CLI and package contracts

The private `@goodvibes-jev/daemon` package exposes an import-inert `./cli`
barrel and a separate executable entrypoint. Source and emitted modules support
its Bun and ESM export conditions. Product identity/version comes from the
actual private manifest, with an exact synchronized compiled fallback; the
binary display name is `goodvibes-daemon`. Unrelated package manifests cannot
supply its version.

## Command grammar and dispatch

The twenty-command vocabulary, aliases, flag arities, refusal statuses, `provider:model`
registry-key syntax, passthrough arguments and platform service wording are
exact program grammar. Bash, zsh and fish completion generation returns scripts;
it does not install them into a shell.

`src/cli/entrypoint.ts` is the side-effectful Bun process entry reached by the
checked-in `bin/goodvibes-daemon`. It supplies `createProductionDaemonRuntime()`
to the dispatcher. The production inbox represents actual unconfigured members
and requires trusted account admission for configured providers; see the
[inbox contract](../../../docs/contracts/daemon-inbox-and-triage.md) and
[runtime ownership](../../../docs/contracts/daemon-runtime-ownership.md).
An embedded dispatcher without an inbox factory refuses serve before acquisition.
Do not recreate the superseded claim that the shipped entrypoint has no factory,
or substitute an empty set for required provider membership.

The dispatcher awaits asynchronous config and one-shot adapters without creating
a second host graph. Canonical tree/identity homes, daemon tier and the historical
`tui` surface remain explicit. Flags override a copied environment, never the
embedding process environment or cwd. Provisioning resolves ownership without
opening or migrating unrelated settings. Serve model, endpoint, config and
feature overrides are runtime-only; refused feature overrides must not be ignored.
Explicit provider flags take precedence over the provider in a qualified model
argument. Completion, help and parse failures occur before configuration access;
provisioning help must not reach a download adapter. OSC-52 output is emitted once.

Serve wires config, event bus, store and an explicitly composed inbox through
`runDaemonProcess`/`createDaemonHost`. Canonical owners retain restart fences,
startup rollback, boot drainage, signal admission and the 15-second terminal
deadline. Capability opt-ins remain explicit. Service activation additionally
requires an explicitly composed installed executable path. Overridden tree or
identity homes refuse before any service inspection/mutation because generated
service definitions cannot preserve them. The shipped entrypoint does not
implicitly grant service activation.

The checked-in launcher exists before dist emission so frozen installation can
create the actual Agent/TUI consumer bin links. The root need not be a daemon
dependency consumer. Preserve manifest/lock/bin metadata agreement and shebangs;
validate a dependency-free frozen fixture install before emission, followed by
execution of that same launcher. Tarball tests use the built owned workspace,
not an unrequested registry release.

Service and strict wake-provisioning state receipts stay on stdout even with a
nonzero status. `service-status --json` remains consumable at exit 3 (installed
but stopped) and exit 4 (not installed), rather than being moved to stderr.

## Status, sessions and config

Status and update reporting preserve HTTP endpoint/envelope selection, the
shared remote-target convention, operator-token handling, partial-failure
reporting, local-only receipt/lifecycle reads and the honest absence of an
early update-check verb. Hosted session list/kill retains the named ws-only
method contract, argument checks, request bodies and daemon error rendering.
The transport helpers are the public terminal-shell exports already hoisted
from the daemon. This product does not maintain a second implementation.

Lifecycle marker bounds, field types, closed status values, argument grammar,
schema-key equality and duration formatting remain structural program contracts.
Config sensitivity remains the canonical terminal-shell decision: declared
schema keys use their schema declaration and unknown nested paths use the
registered credential-key reader. The command helpers return promises,
and every current caller awaits them. The executable dispatcher must await them as well.

### Recursive config output

Object rendering calls the same recursive `redactConfig` used for
JSON output. Scalar rendering, unset/empty/false/zero handling and recognized
secret references retain their original behavior. No lexical sensitivity
fallback or duplicate classifier is permitted.

Tests install the public judgment test port with explicit fixture-path answers.
Only key paths reach that reader; value contents never do. Coverage includes
plain-text/JSON list, get, set and unset receipts and rejection when a nested
path cannot be read. An unavailable reader cannot produce an unclassified
object receipt. The daemon declares judgment as a development dependency for
these fixtures; production dependencies and engine exports are unchanged.

Validate original command assertions with awaited config calls and nested-output
regressions. A real loopback `createRuntimeServices`/`DaemonServer` fixture must
exercise status HTTP, ws-only hosted-session listing, update receipts, invalid
tokens and awaited shutdown. Supplied synthetic inbox/metadata proves composed
caller behavior rather than live provider inference.

## Selected-config HTTPS trust

`products/daemon/src/cli/run.ts` passes an explicit `fetchImpl` through the
existing `RemoteCommandDeps` seam for status/update. It uses the canonical
`createNetworkFetch` and the command's selected `ConfigManager`. Existing
bundled/custom trust modes, relative CA resolution, token/target selection,
HTTP documents, exit statuses and local update receipts are unchanged.
`update --check` still reports that there is no early-update verb; it does not
perform an update or invent a new operation.

The relative CA root remains `ConfigManager.getControlPlaneConfigDir()`, rather
than the working directory or selected daemon identity directory. No new flag,
configuration key, certificate store or global fetch installation is introduced.

### Request ownership

The shared helper carries its explicit reader in an asynchronous context for
the fetch invocation. Product-global wrappers in that call chain read the
explicit scope. The ambient fetch function and middleware remain intact; the
implementation never unwraps them or mutates the installed manager. Asynchronous
middleware and nested work inside that invocation inherit the selected scope;
independent concurrent calls and later unscoped calls retain their own policy.
Caller-provided TLS fields retain their existing precedence. Strict bundled
requests still use Bun's ordinary default trust instead of a synthesized CA set.

The scope is private to the canonical outbound transport module shared by the
public runtime/transport exports. No public API is added. This is HTTPS fetch
ownership; WebSocket, proxy and unrelated transport policy are not changed.

### Validation

Owned loopback HTTPS tests exercise the actual emitted CLI with generated test
certificates and synthetic operator tokens. A valid selected custom CA or
bundled-plus-custom CA succeeds; missing, wrong and bundled-only trust refuse
without disabling certificate verification. Status retrieves its actual HTTP
identity, health, channel and cluster documents. Its separate WSS query remains
reported as unavailable by the fixture. Update reads the synthetic local receipt
without consuming it or requesting a service/update mutation.

Tests cover relative CA paths with incorrect default/cwd/daemon-home decoys,
correct decoys that cannot rescue an incorrect selected CA, unchanged settings
and token bytes, sequential calls, barrier-held concurrent calls, and a prior
global owner whose trust still works after strict scoped calls reject it.
Shared-helper tests preserve middleware guard execution even when it reconstructs
`Request`, explicit per-request TLS, failure cleanup, overlapping scopes and an
unrelated manager change during a held request. These helper cases use a fake
transport and make no network requests.

Status/update HTTPS uses selected-config trust. This does not grant unrelated
WebSocket or proxy callers the same policy or alter system trust.

## Companion identity and startup pairing

- Call the existing `getOrCreateCompanionToken('tui', ...)` owner using the
  canonical, already-resolved `daemonHomeDirectory`. The historical surface
  argument and `<daemonHomeDirectory>/operator-tokens.json` identity stay intact.
- An explicit `GOODVIBES_DAEMON_TOKEN` takes precedence over that stored token;
  `GOODVIBES_HTTP_TOKEN` takes precedence over the effective daemon token for the
  optional HTTP listener. Overrides affect this process and do not replace the
  persisted companion identity. Clients using an override must use that same
  override; a different stored token does not authenticate the running server.
- Reuse the existing token record byte-for-byte on restart. Never search another
  daemon home or adopt workspace-scoped token files.
- Keep acquisition inside the process owner's admitted `start` operation.
  Invalid CLI/default-uncomposed serving and shutdown before startup admission
  create no token. Once acquisition is admitted, the persistent identity remains
  even if a later bind/start fails or shutdown is requested.
- Preserve the actual host's signal fences, restart ownership and awaited drain.
  Generic `createDaemonHost` embedding semantics are unchanged.

Do not use the separate adoption helper `resolveDaemonCompanionToken` for this
boot seam: it persists explicit overrides and would change runtime-only override
semantics.

### Atomic token publication and recovery

The existing engine companion-token owner publishes a complete sibling file
through the shared atomic JSON writer, with mode `0600` and the existing JSON
format. The shared writer rejects short writes before rename in both modes.
Default mode retains its existing file flush, chmod and atomic rename behavior;
this is not a new claim of complete pathname-ancestry durability on every OS.
Pre-publication errors fail startup without replacing an existing complete
record. No separate token persistence or generation implementation is added.

The existing unreadable-store quarantine behavior is retained. The CLI reports
that a new identity was created and paired clients must pair again, and states
whether the previous bytes were preserved. The warning contains neither token
bytes nor the unreadable file's body. Shutdown requested synchronously by that
reporting port prevents graph acquisition. This is not a cross-process token
creation lock: concurrent first boots may still publish distinct complete
records, with the last rename winning.

### Effective token and served origin

Startup renders the effective daemon token;
the secondary HTTP listener token is never substituted. Local `pair` honors its
explicit token, then the process daemon-token override, then the existing stored
identity. Only the stored-file fallback is decoded as a token record. Overrides
remain literal credential bytes and are never adopted into persistent identity.

The control-plane router serves the bundle. The shared engine origin resolver
derives bundled fallback from that binding. An optional
settled binding lets startup use the actual observed host/port after restart
settlement, rather than its intended configuration. The pre-bind diagnostic and
bound receipt retain their separate meanings. Explicit public URLs remain
authoritative, including separately hosted WebUIs with local serving disabled.
Direct TLS uses HTTPS at the actual listener port; proxy mode retains the plain
local HTTP binding unless an external public URL is explicitly configured.
Startup reads the listener owner's captured `boundScheme`, so a TLS setting
changed during held boot cannot relabel a socket that already bound. This adds
no TLS live-restart policy. Offline pair uses the declared configuration.
The exact shipped `http://127.0.0.1:3423` placeholder follows the webui command's
existing equality rule; this is not evidence about who set a stored value.

A local reprint can carry its declared nonzero `--port`, but cannot observe
another process's ephemeral endpoint. Zero or invalid local ports refuse before
credential reads. Public-URL persistence follows the maintenance policy below.

### Trusted output and lifecycle

Automatic credential-bearing output is restricted to an actual interactive stdout
TTY or a composed caller's explicit trusted local `pairingOutput` port.
Ordinary redirected/service diagnostic stdout, stderr, logs and fatal errors
receive no token. Explicit `pair` remains the intentional one-shot reveal.
The shared renderer produces both the QR and its copyable fragment-bearing link.

The startup pairing port is invoked only after the existing host admission,
boot and config-restart settlement fences. Its failure, synchronous shutdown,
or listener loss prevents later readiness and uses the existing complete graph
drain and terminal exit owner. No lifecycle or token owner is duplicated.
The bundled fallback requires the same configured bundle precedence and a
readable app shell. Disabled/missing bundles and malformed credential-bearing,
query/fragment, non-HTTP(S), or wildcard URLs yield a value-free unavailable
notice. Explicit external URLs are configuration authority, not a claim that
this process verified a remote deployment.

### Validation

All fixtures use owned scratch homes, synthetic identity/credentials and
loopback listeners. Source-level host tests exercise the actual ephemeral bound
port, fetch the served app shell, authenticate HTTP with the emitted link token,
and reject the stored/secondary token when overridden. They cover headless
non-disclosure and held graph drainage after pairing-output failure, shutdown
or listener loss. Resolver and adapter regressions cover configured/bound IPv6,
public URL precedence, missing bundles, malformed and empty query/fragment
delimiters, literal JSON-shaped overrides, and invalid local ports.
An owned direct-TLS host serves the printed HTTPS link and authenticates its
token using a generated loopback certificate trusted only by that test client;
certificate verification stays enabled and no system trust is changed.

The emitted launcher fixture uses the real composition port, a synthetic inbox,
and a synthetic static bundle. It checks HTTP and WebSocket authentication with
the printed token, rejects wrong token classes, compares explicit `pair` output,
and verifies exact settings/identity bytes survive runtime overrides and exit.
An actual Bun pseudo-terminal proves default TTY admission without injecting
the pairing-output port; ordinary redirected output is checked independently.

Add token-admission tests for signals, explicit shutdown, invalid options and
refused CLI paths before identity acquisition; actual selected-home restart and
override preservation; atomic publication failures and owner-only file modes.
Served-origin authentication does not prove browser rendering, camera QR scanning,
remote CORS/reverse-proxy setup or real device registration.

## Startup maintenance

The admitted CLI calls `pruneStaleOperatorTokens` after acquiring its
canonical companion identity. Both original workspace candidates come from
`workspaceOperatorTokenCandidates`; the selected daemon-home token is never a
pruning candidate when it aliases either location. The shared pruning owner
compares resolved paths and filesystem device/inode identity, including directory
symlinks in either direction and hard links. Unresolvable or unavailable identity
fails closed. Missing candidates are noops; failed removals produce a
credential-free warning. Token overrides remain runtime-only and do not replace
persistent identity.

After listener boot and restart settlement, Linux startup invokes the existing
`reconcileRedundantLegacyUnit`. It reads a fresh, read-only client configuration
from the selected home/surface, excluding runtime overrides, honors the configured
service name and uses the login home for unit paths. Relocated GoodVibes homes
never enter automatic host service reconciliation. Existing canonical-active,
live-mainpid, self-supervision, running-legacy, configured-endpoint, installer
marker, timeout and retirement-outcome guards remain authoritative. The process
owner aborts reconciliation on close; a late async endpoint probe cannot admit
retirement. The process lifecycle awaits startup settlement and graph drainage.
Refusals/failures have structural receipts; reconciliation failure is non-fatal.

### Empty-only stable public URL

The original shared helper's **empty-only, stable-name-only** policy is retained.
An explicit URL and the shipped nonempty placeholder are not overwritten. The
separate explicit `webui enable` placeholder/posture policy is unchanged.
Persistence requires an enabled readable served bundle and a settled binding
matching declared host/port/TLS configuration. Runtime-origin endpoint/bundle
inputs and ephemeral/drifted ports are not frozen into settings. The shared
helper accepts the observed binding, including its actual HTTPS scheme.
The existing ConfigManager persistence owner writes the selected daemon tier;
failed writes retain its rollback behavior and produce a non-fatal warning.
This happens independently of interactive pairing output. Loopback/IP fallbacks
remain unpersisted because the canonical host resolver does not call them stable.

### Validation

Owned temporary homes and synthetic service runners exercise selected identity
preservation, both stale candidates, alias protection, repeated pruning, runtime
versus persisted endpoint/name, overridden-home refusal, cancellation before and
during probe, served stable-origin persistence and no-write cases. Actual CLI
host tests establish admitted caller ordering, settled observed binding and no
post-shutdown persistence/readiness. Existing service guard/outcome and startup
pairing/diagnostic tests remain regression coverage. No real host unit is
installed, started, stopped, disabled, or removed by this verification.

Retain shared pruning, atomic publication, rotation and pairing-origin tests,
including repeated directory-symlink alias protection while unrelated stale
candidates are removed. Full artifact/API/contract generation and aggregate
qualification remain independent validation layers.

## Pair, WebUI and wake commands

Local pairing reprints the existing token without mutating settings. Remote
pairing preserves the explicit confirmation flag, dry-run plan and named
handoff verb; it renders the returned link or reports missing-origin output.
The shared banner preserves QR, offer and posture rendering. Fixed address
equality, declared offer kinds and link grammar remain code as exact program contracts.

Web serving preserves its explicit posture flags, bundle validation, configured
origin, caller-selected URL and reported restart requirement. Enabling serving
does not change listener posture unless the caller supplies that flag. The
module composes neither a listener nor the WebUI product. Wake provisioning
continues to delegate model identity/checksums and managed-root derivation to
the engine, preserving opt-out and strict/degraded exit behavior.

### IPv6 origins

Web commands and pairing origin construction use the shared `formatHttpOrigin` formatter, exported by the
pairing subpath. Bare and already-bracketed IPv6 inputs produce one valid
authority; hostname and IPv4 formatting retain their existing form. Explicit
public URLs remain authoritative. Product enable/status receipts and local
pairing links have dedicated IPv6 regressions, including the bracketed
loopback case. Web command posture uses the existing origin-posture function,
and custom bindings are not described as necessarily using all interfaces.

### Complete settings transitions

To prevent enabling a network binding before a managed lock can refuse requested
narrowing, the command requires the
canonical `setDaemonValues` capability. It prepares the bundle, listener
posture, serving flags and derived URL together, validates every field and
managed lock, and replaces their single daemon settings file atomically. Live
values and observers are updated only after the complete write. This does not
add transactions across files or concurrent processes. Credential-bearing keys
are outside this batch capability.

The public URL is also prepared before writing. An explicit posture change
continues the default URL when it exactly matches the previously computed
serving origin (ignoring a trailing slash). This is an equality-based command
rule, not proof of who set the old value. A distinct custom URL is preserved;
without an explicit posture change, an existing non-placeholder URL is kept.
This corrects the ordinary enable-then-LAN sequence that otherwise left pairing
links pointing to loopback. Failure to update a required generated URL now
refuses the whole transition instead of enabling with mismatched links.

Real-manager regressions check locks on every updated field, previously enabled
and disabled serving, both posture directions, fresh-reader and exact-file
preservation, the pairing URL sequence and custom URL retention. Engine batch
tests cover read-only/ownership refusal, a real filesystem write failure,
complete snapshots in observers, invalid values and value-free diagnostics.

Pair fixtures use scripted transport replies and synthetic tokens; web fixtures
use owned bundles and in-memory/real isolated configuration. Wake tests use a
rejecting fetch or explicit fixture provisioner, never an uncontrolled model
download. Test actual provisioning opt-out and strict/degraded exit behavior.

## Service commands and recovery

Canonical `PlatformServiceManager` owns service operations. Preserve all seven
subcommand grammars, structured status codes, local service definitions,
login-home versus state-home boundaries, legacy detection and explicit migration
consent. A new unit must be healthy before retiring the old one; unsuccessful
startup rolls back only the newly attempted target. An unidentified process
occupying a port is reported without being killed. Unattended reconciliation
retains canonical liveness, self-supervision, legacy-running, configured-endpoint
and installer-marker guards, plus per-call and cumulative deadlines.

Compiled binary recognition compares the exact declared basename. An interpreter
inside a daemon-named directory or similarly named helper executable is not the
binary. Explicit environment override and packaged-launcher precedence remain.

### Incomplete retirement

Retirement stops when either command does not positively
report success, including timeout or missing status. It retains the old
definition, reports the new healthy unit and the unconfirmed legacy state,
and asks the operator to verify before retrying. No diagnostic text is parsed
to infer that an unsuccessful command meant the unit was already stopped.

Failed/unknown stop or disable, thrown values including undefined, removal
exceptions with empty/absent messages, and reload failures produce nonzero
incomplete receipts. Preserve the healthy new unit once legacy retirement has
begun; do not roll it back after completed retirement steps. A reload exception
after removal must disclose that removal already completed. For unattended
reconciliation, removal exceptions are `failed` / `remove-failed`; failed or
thrown reload is `failed` / `reload-failed`, with completed removal explicit.
No prose parsing may reinterpret an unsuccessful command as a successful stop.

### Read-only preparation and rollback

Service manager construction uses the canonical `ConfigManager` with an
explicit read-only option. The same defaults, layer order and pure migration
transformations are applied in memory; configuration files, migration receipts
and quarantine state are not written. Mutating config methods refuse in this
mode. The product must not eagerly run persistent config migration before a
dry run, rejected endpoint flags or status request; actual daemon boot retains
the separate migration entrypoint.

The service status query does not delete a stale PID file. Explicit stop and
uninstall still own that cleanup. Fixture tests cover manual and Windows
status with malformed PID files without invoking any host process operation.

Migration refuses a managed target that already has a definition or reports
an active runtime, before installation or rollback. Failed setup cleans up
only the newly attempted target and retains recovery state when stop/disable
cannot be confirmed. Tests include custom target names and thrown install or
start failures. Service fixtures model an initially inactive target that
becomes active only after enable, so retirement tests reach their intended
phase rather than falsely declaring a preexisting runtime.

### Ordinary uninstall

Ordinary uninstall requires both an error-free
stop result and no observed running service before calling uninstall. A
nonzero, missing, timed-out or thrown result returns a nonzero incomplete
receipt and does not remove the recovery definition. Empty error text is not
treated as success, and no diagnostic text is interpreted as proof that a
service was already stopped.

The same command also reports an incomplete outcome if the final returned
status is still installed or running. Injected adapter exceptions during
uninstall have a separate receipt: removal may already have happened, and the
included status is explicitly the last confirmed pre-removal observation.
This is bounded adapter-exception hardening, not evidence of a routine
default-runner failure. It performs no automatic retry or additional removal.

### Validation

Use owned temporary homes and injected systemctl/loginctl, TCP, process-liveness,
cgroup and unit-file ports. Use an absolute stub executable for deadline tests;
`exec sleep` avoids orphan descendants. Unconfigured synthetic removal throws
rather than falling through to real paths. Validate dry-run nonmutation,
healthy-new-before-old ordering, collisions, rollback, active/unknown/self-owned
refusal, timeout reinspection, cumulative bounds and exact 0/3/4 status results.
Cover every incomplete retirement/uninstall step, successful active-to-stopped
removal with a neighboring unit unchanged, read-only malformed PID status, custom
names and thrown install/start failures. Actual host installation remains a
separate platform-level action.

## Standalone send

### Admission and selected ownership

The canonical emitted `goodvibes-daemon` executable accepts `send [message]`,
`--channel`, `--to`, `--title` and `--list`. It awaits stdin when no argument is
provided. Parsing/help failures happen before configuration acquisition. A named
channel is selected exactly, and an unnamed channel requires exactly one enabled
configured destination. Canonical gateway, service, routing, delivery and surface
feature gates still apply. Disabled/ambiguous destinations do not fall back.

Send remains a first-token command. Relocated homes are supplied through
`GOODVIBES_HOME` and `GOODVIBES_DAEMON_HOME`, with `GOODVIBES_WORKING_DIR` selecting
the workspace. It uses the same selected ConfigManager and daemon tier as the
other adapters, passing that identity into SecretsManager. Configuration retains
its existing migration and refusal rules. Only an admitted actual delivery
constructs SecretsManager, SubscriptionManager, ServiceRegistry, ArtifactStore
and ChannelDeliveryRouter. No host graph, listener, inbox, discovery task or
notification queue starts. The unused subscription service does not perform its
legacy-store fold during this one-shot acquisition.

Thirteen upstream surfaces are supported: Telegram, ntfy, Discord, Slack,
Google Chat, Signal, WhatsApp, iMessage, Microsoft Teams, BlueBubbles, Mattermost,
Matrix and generic webhooks. Shared canonical owners resolve their declared
credential references. Registry credentials retain precedence; a configured but
unresolved surface fallback cannot silently become an environment credential.
Absent optional bridge authentication remains distinct from failed configured
credentials. No credentials are created or provisioned by the command.

### Message, receipt and lifetime

The explicit command supplies outbound authority for its body. It does not grant
inbound-source processing authority or route arbitrary text through automatic
notification metadata-only policies. Per-surface transformations preserve the
upstream explicit-send markup contract. Telegram stays plain text without a
parse mode; Discord/Slack markup and mentions are escaped. Existing channel
length limits remain. Client URL auto-linking and cosmetic formatting behavior
are not claimed eliminated. No artifacts or control-plane links are synthesized.

Success means the send owner accepted the request. It does not prove arrival or
reading at a recipient. Telegram and Slack bot requests require literal protocol
acknowledgement; response URL HTTP rejection is unsuccessful. Other
HTTP-based owners retain their documented transport-level acknowledgement.
Missing response IDs are valid success; arbitrary provider IDs and capability
URLs never appear in CLI output. Failure says delivery was not confirmed,
publishes only structural status evidence, and adds no command or notification-queue retry.
The existing checked-address connection fallback for pinned webhooks remains.

Explicit sends opt into the existing ntfy duplicate override, so repeated calls
and a repeat after a failed attempt still reach transport. Ordinary notification
deduplication is unchanged. The command awaits the actual credential, fetch and
body owner. Successful transports that do not need their body cancel and await
the retirement attempt. A rejected cleanup is reported structurally without
reversing received acceptance or triggering a duplicate send. No detached timeout race is introduced; the existing per-provider
deadlines remain, and no universal cancellation/deadline guarantee is claimed.

### Diagnostic publication

The preceding channel diagnostic prerequisite withholds credential-bearing URLs
and known capability-derived receipt IDs without changing actual requests. Send
additionally selects structural diagnostics before loading configuration, where
an owned malformed-settings fixture proved that parser errors could echo a
credential through migration logs, ingestion logs and direct stderr. The selected
mode withholds borrowed parse text and malformed-reference descriptors. A
quarantined declared credential holds a one-shot send before fallback resolution,
so a skipped setting cannot silently select another account. It retains
file/key identifiers and the
original private ConfigError for its owner. Existing default diagnostics and
configuration semantics remain available to other callers.

Secret-reference, registry and secret-store read owners have the same additive
structural mode. Delivery credential resolution selects it; the send stack also
selects it on its concrete registry and secret store. Provider error/reference
text, malformed-reference hostnames and unvalidated store-envelope fields remain
private. Resolution results and private errors retain their original semantics.
This command does not classify or
republish arbitrary provider error wording or query values at all. The shared
structural status projection supplies its public diagnostic, while original
private failures remain with existing semantic retry owners. No keyword-based
redaction or substitute semantic guess is added.

These modes are projections at known publication sites, not semantic classifiers,
global logger suppression, or a claim that every application log is public-safe.

### Validation

Owned source tests cover parser/admission ordering, selected settings and secret
ownership, thirteen-provider routing, actual credential-reference wire values,
private errors and IDs, malformed settings stderr, explicit repeat behavior and
held credential/fetch/body retirement. The executable fixtures use the actual
package launcher and an owned ntfy loopback service; no real account, provider
credential, messaging action or host deployment is used.

## Native build and artifact verification

The private package's ordinary build/test workflows remain the TypeScript script
package. Explicit native commands compile the actual CLI entrypoint; they do not
substitute a fixture executable or injected module loader.

`products/daemon/scripts/run-toolchain.ts` resolves the build and smoke CLIs
declared by the installed `@goodvibes-jev/engine` manifest, matching the TUI's
scripts-disabled workspace installation contract. Missing declarations or built
CLI files fail explicitly. It accepts the shared toolchain's native default,
`--all`, and `--target <key>` syntax. This product has one app leg; it rejects
`--daemon-only`, `daemon-*` selectors and ambiguous/unknown wrapper arguments
before running the toolchain. The shared toolchain rejects unknown target keys.

`scripts/compile.ts` calls the same public `compileBunBinary` implementation used
by Agent/TUI, including their compile compatibility assets. The original names
`goodvibes-daemon-{linux,macos}-{x64,arm64}`, Bun target mapping and corresponding
`sqlite-vec-{linux,darwin}-{x64,arm64}/vec0.{so,dylib}` payloads are unchanged.
Linux targets declare the established ordinary Bun 1.3.14 sidecar contract.

Native outputs go to `native/` and `native/lib/`, outside the existing packed
`dist/` tree and outside the package's explicit file allowlist. A local native
build must not contaminate a subsequent script-package tarball.
The manifest's native commands are repository-only: their scripts and toolchain
configuration are intentionally excluded from the Bun script-package tarball.

`scripts/check-version.ts` only validates the private product identity and exact
compiled fallback. Root `sync:version` owns the engine fallback. Intentional
daemon preparation uses the explicit mechanics below; native prebuild remains
read-only and chooses no version stream, release feed or release-cut policy.

`build:binary` compiles the host target. `smoke:binary --binary <path>` uses the
installed engine's actual post-build namespace scan. `verify:binary` consumes an
already-built Linux artifact under ordinary Node and requires working bubblewrap.
The verifier copies the executable, addon, ordinary Bun runtime and runtime
notice/provenance into owned scratch outside the checkout. Child visibility is
restricted to OS libraries and that tree, with a foreign package manifest,
isolated home/state/identity and no source or node_modules. Missing isolation or
required assets fails; no case silently skips.

Validate exact manifest identity despite the foreign manifest, root/sessions
help, exit-2 unknown flags/commands/first-word violations, service activation
refusal before configuration/token/service effects, selected relative-home
config persistence, and actual argv/multiline-stdin sends to an owned ntfy loopback
server. Keep exact body/title/destination/credential and unchanged settings and
secret bytes, with no operator token, lifecycle receipt or detached graph from
one-shot send.

The production verifier exercises real source-free unconfigured inbox startup,
authenticated status/read, malformed settings refusal and SIGTERM/drain. It
waits for actual native memory readiness, exercises add/search and structured
vector availability so lexical fallback cannot stand in for sqlite-vec. Its
recorded model/judgment transport is synthetic. The hosted-session verifier
exercises real compiled HTTP streaming, persisted assistant history, detach
policy, explicit kill and lifecycle boundaries; merely having that code is not
an execution or live-provider receipt. Payload digests are checked again after
execution. See [runtime ownership](../../../docs/contracts/daemon-runtime-ownership.md)
for the served graph and [hosted sessions](hosted-sessions.md) for its API.

Preserve wrapper/version tests and canonical toolchain target/addon/sidecar/smoke
coverage. A missing-entrypoint probe against the actual shared build CLI must
propagate compiler failure as exit 1. Configured cross-platform artifact names
alone do not establish native execution on those platforms.

### Linux CI handoff

The daemon leg of root `product-tests` restores the canonical `build` job's
workspace outputs, completes the declared daemon suite, then builds the actual
Linux x64 entrypoint once. It records and checks `native/ci-artifact.json` before
uploading a tar archive of the executable, ordinary Bun runtime, runtime license
and provenance, and sqlite-vec library. The manifest binds the exact checkout
commit/tree and PR head (or main commit), plus each payload's SHA-256, byte size
and mode. A dirty tracked source tree cannot be recorded as that commit.

The separate `daemon-native` job uses the established `ubuntu-22.04` containment
runner and probes real unprivileged namespaces, without relaxing host security
or running the verifier as root. It requires a successful producer, restores the
canonical workspace output and daemon archive, and checks their daemon manifest
against its exact checkout before running the existing `verify:binary`. Missing
files, source mismatch, tampering and mode loss fail before native execution.
The consumer never rebuilds. Behavioral tests exercise tar restoration and
negative payload/source cases; workflow checks preserve this ordering and the
single build. A missing or skipped producer cannot produce a green consumer.

The release dependency graph requires this consumer under its existing trigger
and `RELEASE_ARMED` policy; this does not independently enable tags or publication.
A missing or skipped producer cannot make its consumer green. Validate actual
tar restoration and negative source/payload/mode cases without consumer rebuild.
Only the supported CI target has an acquisition lane; configured targets and
local cross-target builds are not proof of other-platform acceptance.

### Private offline package/install gate

`native:package` consumes an already-built supported Linux host cohort. Its
explicit artifact root, absolute output filename, source and head commits bind
the existing private manifest and exact target. It chooses no version, rebuilds
nothing, generates no provenance for an unknown binary, and contacts no registry.
See [local native installation](local-native-installation.md) for fixed x64/ARM64
layouts, same-host checks and the narrower CI acquisition policy.

The gate verifies the existing CI manifest and canonical modes, captures only its
five payloads plus the manifest, and checks those captured bytes again. It creates
a tarball with the same exact member paths accepted by the current CI acquisition
reader, restores that actual tarball through that reader, and revalidates it.
Extra workspace/native files are not included. Missing, changed, symlinked or
wrong-source inputs fail closed.

The consumer restores the archive into an owned temporary directory and invokes
the existing transactional installer into a fresh prefix. It then removes the
unpacked input and runs `verify-binary.mjs` against the installed executable and
companions. That verifier requires ordinary Node, Linux and working bubblewrap;
its child sees neither checkout source nor `node_modules`. No missing isolation
case silently succeeds. Installed receipt, identity and checksums are checked
after the behavioral verifier too. Temporary pack/consumer directories are
removed on success or failure. The output file is created exclusively, only after
the full verifier passes, so an existing artifact is never overwritten.

From `products/daemon`, supply the existing cohort explicitly:

```sh
bun run native:package --artifact-root /absolute/producer/products/daemon \
  --output /absolute/private/daemon-native-linux-x64.tgz \
  --source-commit <exact-checkout-sha> --head-commit <exact-head-sha>
```

This is distinct from a script-package npm tarball. It does not establish npm
SDK-pin/lock agreement, registry authentication, a release feed or publication.

## Explicit release preparation

### Opt-in surfaces

- `products/daemon/scripts/release-prepare.ts`, opt-in through `release:prepare`.
- `products/daemon/src/test/scripts/release-prepare.test.ts`, exercising actual
  filesystem writes and the CLI in isolated guarded-runner fixture directories.
- Product manifest version, compiled `src/version.ts` fallback and a README badge
  if one already exists; the actual private README has no badge.
- Caller-owned product `CHANGELOG.md` gets a `## [X.Y.Z] - YYYY-MM-DD` scaffold
  before its first section, never below the first separator. Existing notes and
  introduction remain. Existing matching version sections stay byte-identical.

Exactly one explicit bump/exact/no-bump mode is required. Notes require an
explicit valid date and existing product changelog; `--no-changelog` neither
reads nor creates one.

`--no-bump --no-changelog` is available only as an explicit preparation command;
it does not configure a toolchain releaseCut hook or mutate native prebuild.

SemVer grammar and safe arithmetic are checked. Textual root-property token
location preserves manifest formatting and nested dependency versions and
rejects duplicate root version properties. The private package identity is
required. Exactly one binary fallback is required. Unknown, duplicate,
conflicting and incomplete CLI arguments refuse before mutation.

All inputs are read and validated before writes. Unchanged surfaces are not
written. Repeating exact-version/no-bump preparation is byte-idempotent; an
arithmetic bump explicitly requests another version. Ordinary filesystem write
failure attempts restoration in reverse order, including the failed file
because a write can fail after truncation. Incomplete restoration is surfaced
with original and restoration causes. This is not crash-safe multi-file atomicity. The explicit preparation entry
serializes its complete read/validate/write/compensation operation with the
existing native build/smoke wrapper through a product-checkout mutex. Both use
the engine's canonical cross-process lock in strict-ownership mode: populated
atomic publication, no age-based eviction of live owners, dead-owner recovery,
inode-owned release and bounded waiting. A malformed ownership record refuses
rather than guessing that it is safe to overwrite. Symlink aliases resolve to
the same checkout identity. This does not change the shared root build lock.

The public preparation function is asynchronous and must be awaited. Native
wrapper ownership is retained until its directly owned toolchain child exits;
ordinary termination signals are forwarded to that child. The mutex is advisory:
manual edits/direct invocation of lower-level compile tools bypass it. A hard
kill or host crash is not multi-process-tree termination or crash-safe file
recovery; inspect partial files and any surviving build descendants before
retrying. Use a clean checkout, review the diff and correct any reported
incomplete restoration before release.

### Validation

The original pinned tests' top placement, old-body preservation, existing-section
idempotence, distinct prefix version, empty changelog and bump arithmetic
assertions are retained. Additional tests cover actual manifest/fallback/badge
consistency, escaped root property names and nested version fields, exact repeat
no-write behavior, both independent no-bump/no-changelog modes, missing notes,
invalid inputs and fallback, partial-write compensation and failed compensation,
CRLF notes, and execution of the copied CLI in a fixture checkout.

Retain the SemVer build-metadata badge case and a no-bump-with-metadata then patch
regression. Drive concurrent real preparation processes with delayed writes and
require every requested bump plus coherent manifest/fallback/badge. Run the actual
native wrapper against a declared fixture engine CLI to prove both writer/reader
exclusion directions without compiling. Cover failure release, symlink identity,
live-owner age immunity, exited-owner reclaim, corrupt-record refusal and invalid
argument nonmutation. Use the supported owned engine runner, product types,
workspace/import gates and diff validation. These mechanics do not select shared
versus separate product version streams, rewrite legacy updater policy or activate
service adoption, registry publication or automatic updates.

## Executable validation boundaries

Emitted entrypoint fixtures drive actual help/version/completion/refusal before
configuration, selected-tier config receipts across processes and the real
consumer bin links. Preserve `install-servce` refusal with exit 2 and usage, the sessions help page,
exact `Unknown command: doctor`, and `--daemon-home ... send hello` refusal
because send must be first. These paths create neither daemon-tier nor ordinary
user configuration. Run an
explicitly composed synthetic inbox through actual loopback status/inbox;
SIGINT/SIGTERM cannot report success before a held admitted poll settles and the
listener closes. Runtime endpoint overrides must remain unpersisted.

Test-owned one-shot child waits have a 20-second ceiling and a separate 5-second
kill/reap cleanup bound. Clear timers and close pipes on every result; retain the
original failure if cleanup also fails. A short test deadline against a held poll
must kill/reap without pretending it drained successfully. These fixture bounds
do not change production shutdown deadlines.

Compiler/declaration/public import checks, actual workspace gates, native
artifact execution, platform service tests and live providers are distinct
validation layers. A source-test or synthetic transport pass cannot establish
real-account delivery, remote registration, full platform behavior or release
acceptance.
