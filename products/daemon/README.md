# Daemon command executable and explicit host (partial migration)

This private workspace preserves the pinned daemon's 20-command vocabulary and
now builds the canonical `goodvibes-daemon` Bun command. Its checked-in
executable launcher imports the emitted CLI, so frozen installation can create
consumer links before build. It dispatches the
existing config, status/update, sessions, pairing, cluster, WebUI, wake-model,
completion, help and version adapters. Standalone `send` uses the canonical
channel router and requires no running daemon. Its service inspection, stop and removal
commands retain the existing guarded service adapters.

Default `serve` is still unavailable: built-in inbox composition is unfinished.
A bare invocation fails before acquiring runtime resources or changing files.
Service install/start/restart/migrate requires a
launcher that supplies both real inbox composition and its installed executable
path and canonical (non-overridden) homes, so this package cannot install an
unbootable default service or silently relaunch a different identity.

From this directory:

- `bun run build` emits JavaScript and declarations into `dist/`
- `bun run start -- --help` invokes `dist/cli/entrypoint.js`
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
The caller remains responsible for complete provider membership and trusted
preview mapping. No fixture factory is installed in the executable.

`createEmailDaemonInboxFactory({ account, screening })` supplies an explicit
single-node TLS mailbox inbox with canonical mail lifecycle, complete-source
protection, account-scoped ownership and durable UIDVALIDITY/UID progress. The
root supplies its owned mail-service constructor. First polling records a typed
history boundary; content starts on the next ordinary cadence. Omitted history
and remaining backlog are disclosed separately from provider failures. See
`docs/audit/daemon-email-inbox-composition.md` for prerequisites and limits. This
does not remove default serving's all-provider refusal.

Before constructing its server, the explicit host awaits initial custom-provider
loading and preloads the validated discovery cache from the runtime's selected
home and surface (`.goodvibes/tui/discovered-providers.json`). In that daemon
registry, custom providers keep precedence over same-name cached discoveries.
An absent or empty cache does not clear existing discoveries. Each new hosted
workspace floor also awaits its own initial custom load before copying the
daemon registry's current discovery snapshot and admitting a model selection.
Shutdown drains pending floor acquisition and its cleanup. This does not launch
a LAN scan or watch the cache for updates to existing floors. Cache membership
provides no protected-source authority. See `docs/audit/daemon-provider-preload.md`.

Once explicit startup is admitted, the launcher loads or creates the shared
`operator-tokens.json` in the selected daemon home. The same token authenticates
HTTP and WebSocket clients, and `status` reads that selected-home record without
requiring `--token`. `GOODVIBES_DAEMON_TOKEN` overrides the running server token;
`GOODVIBES_HTTP_TOKEN` overrides the optional HTTP listener token. These overrides
do not rewrite the shared identity. A corrupt store is preserved beside the
replacement when possible, with an explicit warning that clients must pair
again. See `docs/audit/daemon-companion-token-bootstrap.md` for the boundaries.

`status` and `update` use the selected configuration's `network.outboundTls.*`
policy for HTTPS requests. Relative custom CA paths resolve beneath that
configuration's control-plane directory. These commands do not replace the
embedding process's global transport. Status reports its separate WebSocket
session query independently; this HTTPS policy does not configure WSS trust.
See `docs/audit/daemon-cli-http-trust.md`.

After the listener settles, an interactive terminal receives the shared pairing
QR and copyable link using the effective daemon token. Redirected/service stdout
stays credential-free; a composed launcher may explicitly supply a trusted local
`pairingOutput` sink. Bundled WebUI links use the actual control-plane listener,
while a configured external WebUI URL remains authoritative. Missing local
bundles and unusable URLs produce a value-free notice instead of a dead QR.
`pair` is an explicit credential reveal: pass the same daemon-token environment
override (or `--token`) and any overridden nonzero `--port` to reproduce the link.
A separate command cannot discover an unrelated process's ephemeral binding.
See `docs/audit/daemon-functional-pairing-startup.md`.

`goodvibes-daemon send "message" --channel ntfy` sends through one of the thirteen
configured channels; omit the message to read stdin. `send --list` shows enabled
channels and configured destinations, withholding declared credential-bearing
URLs. With no channel named, exactly one enabled channel must have a destination.
`--to` overrides it and `--title` supplies a surface title. Disabled channels and
missing canonical capability gates refuse without falling back to another target.
The result confirms acceptance of the send request, not arrival at the recipient;
uncertain failures exit nonzero and are not retried. Provider IDs, private failure
text and credential-bearing destination URLs are not printed. The existing
per-channel formatting and length limits apply. See `docs/audit/daemon-standalone-send.md`.

For an explicitly configured single-node Slack host, the same CLI export now
provides `createSlackDaemonInboxFactory({ account, screening, timeoutMs? })`.
Pass its result as `runtime.inboxFactory`. The account supplies the expected
workspace and user/bot identity; `screening` supplies the established local
source-service authority and proposal/Jev endpoints. Existing canonical settings
must enable Slack, select that workspace and disable cluster mode; credentials
come from the existing daemon credential resolver. This factory owns real Slack
history polling, protected content previews, an account-specific SQLite mirror
and authenticated reads, including token rotation and awaited shutdown. See
`docs/audit/daemon-slack-inbox-composition.md` for the exact trusted inputs,
transport and live-proof requirements. It does not compose other providers or
claim clustered startup support.

`GOODVIBES_HOME` relocates the state-tree home. `--daemon-home` or
`GOODVIBES_DAEMON_HOME` relocates only the daemon identity/settings tier;
`--working-dir` selects the workspace. CLI flags do not mutate the embedding
process environment or cwd. Raw-intercept commands including `send` must be the
first argument; use the documented environment homes for relocated one-shot sends. Serve's model, endpoint, config and feature flags
are runtime-only and never saved as settings.

The package remains a private Bun script package with an opt-in local native
build. No native release is published. It keeps its historical version. Source
and emitted modules are included because the existing Bun export condition uses
source. Use the supported Bun 1.3.14 runtime and built engine workspace.

See `docs/audit/daemon-cli-entrypoint.md` in the repository for exact caller
mapping, tests and outstanding parity, and `docs/audit/daemon-native-packaging.md`
for local artifact proof and release limitations. The strict `migration:complete` gate must
continue to reject this partial workspace. The original source is
`mgd34msu/goodvibes-daemon` at `443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
reconciled through `254699bf5d834cdca41436211ada1ae32bf89258`.
