# Daemon command executable and explicit host (partial migration)

This private workspace preserves the pinned daemon's 20-command vocabulary and
now builds the canonical `goodvibes-daemon` Bun command. Its checked-in
executable launcher imports the emitted CLI, so frozen installation can create
consumer links before build. It dispatches the
existing config, status/update, sessions, pairing, cluster, WebUI, wake-model,
completion, help and version adapters. Its service inspection, stop and removal
commands retain the existing guarded service adapters.

Default `serve` is still unavailable: built-in inbox composition is unfinished.
A bare invocation fails before acquiring runtime resources or changing files.
`send` also refuses explicitly. Service install/start/restart/migrate requires a
launcher that supplies both real inbox composition and its installed executable
path and canonical (non-overridden) homes, so this package cannot install an
unbootable default service or silently relaunch a different identity.

From this directory:

- `bun run build` emits JavaScript and declarations into `dist/`
- `bun run start -- --help` invokes `dist/cli/entrypoint.js`
- `bun dist/cli/entrypoint.js config get controlPlane.port --json`
- `bun run typecheck` checks source and tests
- `bun run test` rebuilds and runs the guarded suites, including the emitted CLI

The `@goodvibes-jev/daemon/cli` export provides the parser/catalog and an inert
`runDaemonCli(argv, options)` dispatcher. An embedding launcher may supply
`options.runtime.inboxFactory` and explicitly select external-agent observation,
host power and wake-model provisioning through the same runtime object. Serving
then constructs the real `createDaemonHost` and runs its signal/deadline owner;
shutdown awaits admitted work and complete owned-resource drainage. There is no
empty production inbox, dynamic composition-module loader or detached server.
The caller remains responsible for complete provider membership and trusted
preview mapping. No fixture factory is installed in the executable.

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
process environment or cwd. Serve's model, endpoint, config and feature flags
are runtime-only and never saved as settings.

This is a Bun script package, not a published native/self-contained daemon
release. The package keeps its historical version and remains private. Source
and emitted modules are included because the existing Bun export condition uses
source. Use the supported Bun 1.3.14 runtime and built engine workspace.

See `docs/audit/daemon-cli-entrypoint.md` in the repository for exact caller
mapping, tests and outstanding parity. The strict `migration:complete` gate must
continue to reject this partial workspace. The original source is
`mgd34msu/goodvibes-daemon` at `443e5ee4d6cda0d36d57e2886398d0836074a4a9`,
reconciled through `254699bf5d834cdca41436211ada1ae32bf89258`.
