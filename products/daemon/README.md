# Daemon command executable and explicit host (partial migration)

Package: `@goodvibes-jev/daemon` · product version `1.28.25` · `private: true`.
The repository root is separately versioned `2.0.23`; these manifest facts do not
choose a shared or product-specific release policy. [MIT license](LICENSE),
Copyright (c) 2026 Mike Davis.

## Operator guides

- [Command reference](docs/commands-reference.md): complete vocabulary, flags, refusals and remote conventions
- [Configuration](docs/configuration.md): exact homes, layers, persistent keys and runtime overlays
- [Hosted sessions](docs/hosted-sessions.md): Jev authority, trust, detach/kill, leases and recovery
- [Testing and validation](docs/testing-and-validation.md): actual scripts, official runner and proof limits
- [Local native installation and rollback](docs/local-native-installation.md): explicit offline prefix operations for the qualified Linux cohort
- [Troubleshooting](docs/troubleshooting.md): startup, authentication, binding, services and tool refusals

These guides reconstruct pinned upstream responsibilities against current source,
not a claim that lost executor documentation or validation receipts were recovered
byte-for-byte. Configured standalone screening bootstrap, the configured Discord
inbox/DM catalog, release/update policy and final native/live calibration remain gates.

## Product boundary

This private workspace preserves the pinned daemon's 20-command vocabulary and
now builds the canonical `goodvibes-daemon` Bun command. Its checked-in
executable launcher prefers the emitted CLI, so frozen installation can create
consumer links before build. If emitted output is absent, a verified private
`goodvibes-jev` monorepo checkout can run `src/cli/entrypoint.ts` in the same Bun
process. A package merely containing `src` is not a source checkout; missing
installed output reports the required root build command. Emitted runtime errors
remain errors and never trigger a fallback to different code. It dispatches the
existing config, status/update, sessions, pairing, cluster, WebUI, wake-model,
completion, help and version adapters. Standalone `send` uses the canonical
channel router and requires no running daemon. Its service inspection, stop and removal
commands retain the existing guarded service adapters.

The shipped `serve` (or bare invocation) admits a genuinely unconfigured inbox:
Slack, Discord and email are all reported explicitly as `unconfigured`, with no
source polling or mirror storage. Configured sources require established account
and trusted-local screening authority; missing or unreadable authority refuses
startup and rolls back owned resources. An unavailable credential store is not
reported as a fresh install.
Service install/start/restart/migrate requires a
launcher that supplies both real inbox composition and its installed executable
path and canonical (non-overridden) homes, so this package cannot install an
unbootable default service or silently relaunch a different identity.

From this directory:

- `bun run build` emits JavaScript and declarations into `dist/`
- `bun run start -- --help` invokes `dist/cli/entrypoint.js`
- `bun src/cli/entrypoint.ts --help` explicitly exercises current source, even
  when older emitted output exists; the bin launcher always prefers `dist`
- `bun bin/goodvibes-daemon --help` uses emitted output or, only when absent in
  this source checkout, the source fallback
- `bun dist/cli/entrypoint.js config get controlPlane.port --json`
- `bun run typecheck` checks source and tests
- `bun run test` rebuilds and runs the guarded suites, including the emitted CLI

Repository-only, opt-in local native packaging (first run `bun run build` at the
repository root to build the installed engine toolchain):

- `bun run build:binary` compiles the real CLI for this host into `native/`
- `bun run build:binary --target linux-x64` selects one of `linux-x64`,
  `linux-arm64`, `darwin-x64`, or `darwin-arm64`; `--all` selects all four
- `bun run smoke:binary --binary native/goodvibes-daemon-linux-x64` runs the
  shared version/banner and emitted-artifact scan (substitute your target)
- `bun run verify:binary` runs the stronger Linux host proof with ordinary Node
  and bubblewrap: a copied artifact set, isolated homes and a foreign cwd,
  no checkout or `node_modules`, real config persistence and synthetic loopback
  sends through argv and stdin. Missing artifacts or isolation fail the command.

The script launcher never silently selects a binary from `native/` or `vendor/`
and never fetches a missing binary. Invoke a locally built native artifact by its
explicit path when that is the artifact you intend to exercise. Its distribution,
installation and updater activation remain separately unconfigured.

Keep the binary together with its `lib/` addon directory and, on Linux, the
adjacent `.bun`, `.bun.json` and `.bun.LICENSE.md` runtime files. Linux builds
require ordinary Bun 1.3.14. Native output is excluded from the script package's
file allowlist and never goes into `dist/`. The native prebuild validates that
`package.json` and the baked `src/version.ts` fallback agree; repair both as part
of an intentional version change. It never bumps or prepares a release.
These scripts and `toolchain.config.json` are checkout tooling, intentionally
absent from the packed Bun script package. Run native commands from this repository.

The `@goodvibes-jev/daemon/cli` export provides the parser/catalog and an inert
`runDaemonCli(argv, options)` dispatcher. An embedding launcher may supply
`options.runtime.inboxFactory` and explicitly select external-agent observation,
host power and wake-model provisioning through the same runtime object. Serving
then constructs the real `createDaemonHost` and runs its signal/deadline owner;
shutdown awaits admitted work and complete owned-resource drainage. There is no
empty production inbox, dynamic composition-module loader or detached server.
`createProductionDaemonRuntime({ slack?, email? })` supplies the pinned complete
membership with canonical protected Slack/email account owners when explicitly
admitted. The shipped executable uses it without inferred account grants. No
fixture factory is installed. A configured Discord account remains refused until
a supported complete catalog and trusted screening owner are supplied. See
[production intake contract](../../docs/contracts/daemon-runtime-ownership.md#production-intake-and-selected-transport) for the configured deployment boundary.

`createEmailDaemonInboxFactory({ account, screening })` supplies an explicit
TLS mailbox inbox for single-node or account-eligible clustered operation, with
canonical mail lifecycle, complete-source protection, account-scoped ownership
and durable UIDVALIDITY/UID progress. The root supplies its owned mail-service
constructor and, in cluster mode, awaitable election gates. First polling records
a typed history boundary; content starts on the next ordinary cadence. Omitted history
and remaining backlog are disclosed separately from provider failures. See
[audit: daemon-email-inbox-composition](../../docs/audit/daemon-email-inbox-composition.md) for prerequisites and limits. This
does not infer a grant for configured standalone accounts.

Before constructing its server, the explicit host awaits initial custom-provider
loading and preloads the validated discovery cache from the runtime's selected
home and surface (`.goodvibes/tui/discovered-providers.json`). In that daemon
registry, custom providers keep precedence over same-name cached discoveries.
An absent or empty cache does not clear existing discoveries. After preload, one
owned background LAN scan feeds nonempty results into this registry and persists
them under the selected home/surface without delaying listener startup or changing
the selected model. Close immediately suppresses late result application and
awaits scan/persistence settlement; the scanner does not support cancellation. Each new hosted
workspace floor also awaits its own initial custom load before copying the
daemon registry's current discovery snapshot and admitting a model selection.
Shutdown drains pending floor acquisition and its cleanup. Floors do not launch
their own LAN scans or watch the cache for updates. Cache membership
provides no protected-source authority. See [provider preload contract](../../docs/contracts/daemon-runtime-ownership.md#provider-preload-and-background-discovery).

Once explicit startup is admitted, the launcher loads or creates the shared
`operator-tokens.json` in the selected daemon home. The same token authenticates
HTTP and WebSocket clients, and `status` reads that selected-home record without
requiring `--token`. `GOODVIBES_DAEMON_TOKEN` overrides the running server token;
`GOODVIBES_HTTP_TOKEN` overrides the optional HTTP listener token. These overrides
do not rewrite the shared identity. A corrupt store is preserved beside the
replacement when possible, with an explicit warning that clients must pair
again. See [audit: daemon-companion-token-bootstrap](../../docs/audit/daemon-companion-token-bootstrap.md) for the boundaries.

`status` and `update` use the selected configuration's `network.outboundTls.*`
policy for HTTPS requests. Relative custom CA paths resolve beneath that
configuration's control-plane directory. These commands do not replace the
embedding process's global transport. The selected socket factory also applies these settings to WSS upgrades for
status/session queries, which are reported independently of the HTTP subqueries.
This does not establish equivalent trust behavior for every delegated command.
See [audit: daemon-cli-http-trust](../../docs/audit/daemon-cli-http-trust.md).

After the listener settles, an interactive terminal receives the shared pairing
QR and copyable link using the effective daemon token. Redirected/service stdout
stays credential-free; a composed launcher may explicitly supply a trusted local
`pairingOutput` sink. Bundled WebUI links use the actual control-plane listener,
while a configured external WebUI URL remains authoritative. Missing local
bundles and unusable URLs produce a value-free notice instead of a dead QR.
`pair` is an explicit credential reveal: pass the same daemon-token environment
override (or `--token`) and any overridden nonzero `--port` to reproduce the link.
A separate command cannot discover an unrelated process's ephemeral binding.
See [audit: daemon-functional-pairing-startup](../../docs/audit/daemon-functional-pairing-startup.md).

`goodvibes-daemon send "message" --channel ntfy` sends through one of the thirteen
configured channels; omit the message to read stdin. `send --list` shows enabled
channels and configured destinations, withholding declared credential-bearing
URLs. With no channel named, exactly one enabled channel must have a destination.
`--to` overrides it and `--title` supplies a surface title. Disabled channels and
missing canonical capability gates refuse without falling back to another target.
The result confirms acceptance of the send request, not arrival at the recipient;
uncertain failures exit nonzero and are not retried. Provider IDs, private failure
text and credential-bearing destination URLs are not printed. The existing
per-channel formatting and length limits apply. See [audit: daemon-standalone-send](../../docs/audit/daemon-standalone-send.md).

For an explicitly configured Slack account, the same CLI export provides
`createSlackDaemonInboxFactory({ account, screening, timeoutMs? })`.
Pass its result as `runtime.inboxFactory`. The account supplies the expected
workspace and user/bot identity; `screening` supplies the established local
source-service authority and proposal/Jev endpoints. Existing canonical settings
must enable Slack and select that workspace; credentials come from the existing
daemon credential resolver. This factory owns real Slack history polling,
protected content previews, an account-specific SQLite mirror
and authenticated reads, including token rotation and awaited shutdown. See
[audit: daemon-slack-inbox-composition](../../docs/audit/daemon-slack-inbox-composition.md) for the exact trusted inputs,
transport and live-proof requirements. It does not compose other providers or
infer admission for configured standalone accounts.

In cluster mode, these explicit factories authenticate expected account metadata
before enrolling through the canonical root's owned election gates. Slack also
requires the root's config/credential invalidation subscription. Email eligibility
does not require a preexisting UID checkpoint. Actual authority invalidation
withdraws and drains accepted polling before reentry. A held content result does
not itself withdraw membership or block holder heartbeats. Standby reads remain
account- and generation-protected. State is node-local: returning nodes resume
their own committed mirror; cold nodes use each provider's bounded initialization.
Email discloses omitted history and pending backlog. There is no previous-holder
cursor transfer, globally
identical feed or exactly-once guarantee. A failed owned drain prevents local
reentry and explicit RESIGN, but heartbeat expiry may still permit peer takeover;
this is not a distributed lease or a global no-overlap guarantee.

`GOODVIBES_HOME` relocates the state-tree home. `--daemon-home` or
`GOODVIBES_DAEMON_HOME` relocates only the daemon identity/settings tier;
`--working-dir` selects the workspace. CLI flags do not mutate the embedding
process environment or cwd. Raw-intercept commands including `send` must be the
first argument; use the documented environment homes for relocated one-shot sends. Serve's model, endpoint, config and feature flags
are runtime-only and never saved as settings.

The package remains a private Bun script package with an opt-in local native
build. The local tooling does not publish a native release or activate automatic
updates. Product/root version ownership and the release feed remain undecided. Source
and emitted modules are included because the existing Bun export condition uses
source. Use the supported Bun 1.3.14 runtime and built engine workspace.

See [audit: daemon-cli-entrypoint](../../docs/audit/daemon-cli-entrypoint.md) in the repository for exact caller
mapping, tests and outstanding parity, and [audit: daemon-native-packaging](../../docs/audit/daemon-native-packaging.md)
for local artifact proof and release limitations. Source accounting and remaining
product acceptance are maintained in [THE-18](https://linear.app/the-artificery/issue/TA-18/port-daemon-composition-and-remote-cluster-infrastructure).
Use `bun run products:check` for executable workspace checks; it does not certify
behavioral parity, native platform qualification or release acceptance.

### Multiple explicitly owned inbox sources

Trusted launchers can combine `createSlackDaemonInboxSourceFactory` and
`createEmailDaemonInboxSourceFactory` with
`createMultiOwnerDaemonInboxFactory([...sources])`, exported from the daemon CLI
boundary. The composite registers one canonical `channels.inbox.list` timeline;
each source retains its own account database, lock, read proof and cluster gate.
Duplicate wire provider IDs are rejected. Explicit provider membership is still
required for custom composition. The production constructor includes explicit
unconfigured membership, but does not supply an active Discord adapter. See [audit: daemon-multiowner-inbox-composition](../../docs/audit/daemon-multiowner-inbox-composition.md) for lifecycle,
pagination and protected-read contracts.

## Explicit local release preparation

`bun run release:prepare --no-bump --no-changelog` synchronizes the compiled
version fallback with this product's manifest (and a README version badge if
one exists). It is opt-in; ordinary builds still only validate the fallback.

After a product release/version policy is chosen, the same mechanics accept one
explicit `--patch`, `--minor`, `--major`, or `--version X.Y.Z` instead of
`--no-bump`. To scaffold notes, provide a product-owned `CHANGELOG.md` and
`--date YYYY-MM-DD` instead of `--no-changelog`. The section is inserted above
the first existing section, preserving old notes. Review and complete the notes.
Exact-version and no-bump runs are byte-idempotent; another arithmetic bump is
a new bump. Missing/ambiguous inputs fail before writes. Ordinary write failures
attempt to restore every touched file, reporting incomplete restoration. This
is not a crash-safe or concurrent multi-file transaction; use a clean, exclusive
checkout and inspect the diff before continuing.

These mechanics do not select shared versus daemon-specific version ownership,
migrate saved updater settings, configure release-cut, publish, tag, commit,
install or deploy anything. See [the bounded audit](../../docs/audit/daemon-release-preparation.md).

Historical upstream release notes are preserved in [the provenance-labelled archive](docs/history/README.md); they are not current product release claims.
