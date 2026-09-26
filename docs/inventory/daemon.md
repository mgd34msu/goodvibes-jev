# Daemon inventory: goodvibes-daemon to products/daemon and packages/engine

Every tracked file of goodvibes-daemon (281 files, from `git -C ~/Projects/goodvibes-daemon ls-files`), read in full, with its disposition and, for a JEV or HOIST file, its decision points. Nothing is dropped unless it is specific to WRFC or QEMU; the intent document's other DROP calls for this product (the legacy daemon migration and reconcile) are void per the owner ruling of 2026-09-26, so those two files carry PORT instead, once read and confirmed to hold no WRFC or QEMU content. Everywhere else, the old code either ports exactly or is updated to use Jev where judgment applies. A HOIST file moves into packages/engine; when it also contains guesswork, its decision points are listed exactly like a JEV file's, and its row names the engine subsystem it lands in. No file in this product both stays in products/daemon and needs a Jev reading: every site with real natural-language guesswork (payments' merchant judge and reply reading, the triage scorer) sits inside a subsystem the intent already hoists into the engine, so this inventory has zero plain-JEV rows; the guesswork is recorded on the HOIST row instead. Security checks, money arithmetic, fixed formats and HTTP status handling are never decision points, in this product or after it moves. docs/inventory/engine.md is the matching inventory for packages/engine (from goodvibes-sdk), and docs/inventory/wrfc-to-jev.md maps every WRFC function to its Jev form.

Files: 281. PORT 192, JEV 0, HOIST 89, DROP 0. Decision points: 3.

| Area | Files | PORT | JEV | HOIST | DROP | Decision points |
|---|---|---|---|---|---|---|
| CLI | 11 | 11 | 0 | 0 | 0 | 0 |
| Send | 9 | 9 | 0 | 0 | 0 | 0 |
| Config | 10 | 10 | 0 | 0 | 0 | 0 |
| Daemon composition core | 45 | 45 | 0 | 0 | 0 | 0 |
| Test infrastructure | 20 | 20 | 0 | 0 | 0 | 0 |
| Packaging and tooling | 45 | 45 | 0 | 0 | 0 | 0 |
| Handler registration | 7 | 6 | 0 | 1 | 0 | 0 |
| Runtime composition | 48 | 46 | 0 | 2 | 0 | 0 |
| Drafts | 5 | 0 | 0 | 5 | 0 | 0 |
| Inbox | 17 | 0 | 0 | 17 | 0 | 0 |
| Payments | 18 | 0 | 0 | 18 | 0 | 0 |
| Routing | 8 | 0 | 0 | 8 | 0 | 0 |
| Triage | 16 | 0 | 0 | 16 | 0 | 3 |
| Remote execution | 17 | 0 | 0 | 17 | 0 | 0 |
| Cluster call plumbing | 5 | 0 | 0 | 5 | 0 | 0 |

## CLI

| File | Disposition | Note |
|---|---|---|
| `daemon/src/cli/command-catalog.ts` | PORT | The daemon binary's whole command vocabulary as data (names, aliases, flags, arity), read by the shared terminal-shell parse engine. Pure data table, no free-text interpretation. |
| `daemon/src/cli/completion.ts` | PORT | Generates bash/zsh/fish completion scripts by deriving exact command/flag/subcommand word lists from the catalog. Exact-string offering only, no fuzzy or similarity matching. |
| `daemon/src/cli/help.ts` | PORT | Renders the top-level help and per-command help pages from the catalog's own data. |
| `daemon/src/cli/index.ts` | PORT | Barrel export for the CLI module (types, catalog, parser, help, completion). |
| `daemon/src/cli/parser.ts` | PORT | Calls the shared terminal-shell `parseWithCatalog` engine against this binary's catalog; every refusal is a fixed structural check (unknown token, wrong arity), never natural-language interpretation. |
| `daemon/src/cli/surface-catalog.ts` | PORT | Static table of channel surfaces and the settings keys each needs, shared between `send --list` and `goodvibes surfaces list`. |
| `daemon/src/cli/types.ts` | PORT | Type definitions for parsed CLI flags and parse results. |
| `daemon/src/test/cli/command-catalog.test.ts` | PORT | Hand-written assertions that the catalog's vocabulary matches exactly what the binary dispatches on. |
| `daemon/src/test/cli/completion.test.ts` | PORT | Asserts every completion script offers every catalog command, alias and flag. |
| `daemon/src/test/cli/help.test.ts` | PORT | Asserts the help text names every real command and no others. |
| `daemon/src/test/cli/parser.test.ts` | PORT | Asserts the "serve on bare invocation or `serve`, refuse everything else" parsing contract. |

## Send

| File | Disposition | Note |
|---|---|---|
| `daemon/src/core/pairing-banner.ts` | PORT | Renders the pairing block (deep link, QR, capability list) shared by daemon boot and `goodvibes-daemon pair`. Pure function of structured input. |
| `daemon/src/daemon/send/channels.ts` | PORT | Derives the list of channels `send` can reach from the surface catalog, and resolves a default channel by an explicit business rule (exactly one enabled-and-configured channel qualifies; more than one is refused rather than guessed at, by design, not by a scoring heuristic). |
| `daemon/src/daemon/send/command.ts` | PORT | `goodvibes-daemon send`: parses flags, resolves the channel, and calls the shared `ChannelDeliveryRouter`. All refusals are deterministic (channel disabled, feature gate off, empty message). |
| `daemon/src/daemon/send/composition.ts` | PORT | Composes the minimal service set `send` needs (config manager, secrets manager, delivery router) without starting the full daemon runtime. |
| `daemon/src/daemon/send/failure-text.ts` | PORT | Redacts credentials from a provider's raw failure text using fixed regexes against known wire shapes (Telegram bot-token-in-path, `user:pass@host` URLs, `?token=` query params). Matching fixed machine syntax, not natural-language classification; confirmed, no decision points. |
| `daemon/src/daemon/send/inert-text.ts` | PORT | Escapes per-surface markup (Discord, Slack, Google Chat, WhatsApp) by a fixed table keyed on which delivery strategy renders markup versus plain text. Confirmed deterministic; no decision points. |
| `daemon/src/daemon/send/stdin.ts` | PORT | Reads all of stdin as the message body when no argument was given. |
| `daemon/src/test/daemon/send-command.test.ts` | PORT | Drives `runSendCommand` with the delivery call stubbed, asserting the exact request built. |
| `daemon/src/test/daemon/send-wire.test.ts` | PORT | Drives the real `ChannelDeliveryRouter` and per-surface strategies with only the network stubbed, asserting real wire bytes. |

## Config

| File | Disposition | Note |
|---|---|---|
| `daemon/src/config/checkpoint-settings.ts` | PORT | Reads the `checkpoints.*` passthrough settings block (guard toggles, size ceiling, retention) for the SDK's `WorkspaceCheckpointManager`, and the daemon's own `checkpoints.unregisteredWorkspaces` enforcement switch. Plain typed field reads with a closed two-value enum (`'off' \| 'guarded'`), not a decision point. |
| `daemon/src/config/config-key-guard.ts` | PORT | `isKnownConfigKey`: a type-narrowing predicate checking whether a runtime string matches an entry in the config schema array. Exact membership check, not a guess. |
| `daemon/src/config/run-daemon-config-migration.ts` | PORT | Calls the SDK's idempotent daemon-owned-config migration at every composition root, tolerating and logging any failure without aborting startup. |
| `daemon/src/config/secret-config.ts` | PORT | Fixed set of config keys that must route through the secret store (`SECRET_CONFIG_KEYS`), plus deterministic helpers building the `GOODVIBES_<KEY>` secret name and the `goodvibes://secrets/...` reference format, and choosing which secret scope (`daemon` vs `user`) a write defaults to based on whether the config key is daemon-owned. All exact string/set-membership logic. |
| `daemon/src/config/secrets.ts` | PORT | Daemon's `SecretsManager` subclass: pins the surface root to `tui`, and adds an escape hatch so a literal secret value that happens to look like a `goodvibes://` reference is stored base64-encoded instead of being misread as a reference. Deterministic prefix/decode logic. |
| `daemon/src/config/surface.ts` | PORT | Exports the single constant `GOODVIBES_DAEMON_SURFACE_ROOT = 'tui'`, the on-disk state-root segment every daemon store resolves under. |
| `daemon/src/version.ts` | PORT | Resolves the running version from `package.json` at runtime, guarded by package-name check so a compiled binary never reports a bundled dependency's version; falls back to a prebuild-stamped literal. |
| `daemon/src/test/config/config-key-guard.test.ts` | PORT | Asserts `isKnownConfigKey` accepts every schema key and rejects unknown/near-miss keys; exercises `config/config-key-guard.ts` (Config). |
| `daemon/src/test/config/daemon-credential-scope.test.ts` | PORT | Asserts a credential configured on one surface is usable by the daemon regardless of which surface is running; exercises `config/secret-config.ts` (Config). |
| `daemon/src/test/cluster/replication-policy-drift.test.ts` | PORT | Pins this repository's own secret-key derivation (`buildGoodVibesSecretKey` in `src/config/secret-config.ts`) against the SDK's `replicatedSecretKeyFor`, so the two never drift; exercises `config/secret-config.ts`, not the cluster call plumbing. |

## Daemon composition core

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/cli.ts` | PORT | The daemon binary's entry point and composition root: intercepts `cluster`/`send`/`provision-wake-model`/`webui` before the parser, dispatches the remaining commands, and (on a bare invocation or `serve`) builds the full runtime graph and starts serving. Every branch is a structural command dispatch, not a guessed classification. |
| `daemon/src/daemon/config-command.ts` | PORT | `config list\|get\|set\|unset`, backed directly by `ConfigManager`; redaction is by a fixed sensitive-path check (`isSensitiveConfigPath`), not text classification. |
| `daemon/src/daemon/lifecycle.ts` | PORT | Resolves whether this process is a compiled-binary install (eligible for the SDK's self-update loop) versus a dev/source or bun-global install, by a structural `detectInstallKind` check on the exec path. |
| `daemon/src/daemon/local-daemon-state.ts` | PORT | Reads the daemon's own lifecycle-marker and receipts JSON files (uptime, crash/rollback history) with bounded, validated parsing. Read-only, deterministic. |
| `daemon/src/daemon/pair-command.ts` | PORT | `goodvibes-daemon pair`: reprints the local pairing banner, or mints a new per-device token on a named remote daemon after explicit `-y` consent. |
| `daemon/src/daemon/provision-wake-model.ts` | PORT | `goodvibes-daemon provision-wake-model`: calls the SDK's pinned wake-word provisioning function; always exits 0 unless `--strict`. No text classification. |
| `daemon/src/daemon/service-commands.ts` | PORT | `install-service\|uninstall-service\|service-status\|migrate-service\|start\|stop\|restart-service`, all dispatched onto the SDK's `PlatformServiceManager` and the legacy-unit migration engine (see Runtime composition) with fixed, deterministic checks. |
| `daemon/src/daemon/sessions-command.ts` | PORT | `sessions list\|kill <id>`, thin parse-call-render wrapper over the `sessions.hosted.*` verbs; decides nothing about what a session is. |
| `daemon/src/daemon/status-command.ts` | PORT | `status` and `update`: calls fixed daemon routes/verbs and renders their fields; every enum comparison (`state !== 'ready'`) is against a closed, machine-defined set, not free text. |
| `daemon/src/daemon/webui-command.ts` | PORT | `webui enable\|disable\|status`: writes fixed config keys and validates a bundle directory by checking for `index.html`'s existence, a structural file check. |
| `daemon/src/test/daemon/cli-dispatch-wiring.test.ts` | PORT | Asserts the entry point's raw-intercept dispatch order against its own source. |
| `daemon/src/test/daemon/config-command.test.ts` | PORT | Exercises `runConfigCommand` against a stub `ConfigManager`. |
| `daemon/src/test/daemon/control-routes.test.ts` | PORT | Exercises the SDK's `createDaemonControlRouteHandlers` (status/auth responses); the SDK's own module, imported here for this product's route composition test. |
| `daemon/src/test/daemon/daemon-route-seams.test.ts` | PORT | Exercises the SDK's channel/integration/system/knowledge/media daemon route-handler factories as this product wires them. |
| `daemon/src/test/daemon/error-response.test.ts` | PORT | Asserts `jsonErrorResponse` preserves structured metadata for a `ProviderError`. |
| `daemon/src/test/daemon/fatal-boot-report.test.ts` | PORT | Compiles and runs a real binary to prove a boot failure reaches stdout/stderr, guarding against the historical silent-crash-loop defect. |
| `daemon/src/test/daemon/fixtures/daemon-fatal-boot-entry.ts` | PORT | Compilable fixture mirroring `cli.ts`'s fatal-boot tail exactly, for the binary-level proof above. |
| `daemon/src/test/daemon/fixtures/daemon-fatal-boot-legacy-entry.ts` | PORT | Compilable fixture reproducing the pre-fix (silent) fatal-boot tail, the control baseline for the same proof. |
| `daemon/src/test/daemon/gateway-acp-verbs.test.ts` | PORT | Asserts `acp.agents.list`/`acp.sessions.create` are registered and invokable on this daemon's composed runtime. |
| `daemon/src/test/daemon/gateway-catalog-handler-or-route.test.ts` | PORT | Whole-catalog partition test: every advertised verb is reachable by some path or honestly reports it is not. |
| `daemon/src/test/daemon/gateway-checkin-round-trip.test.ts` | PORT | End-to-end check-in verb family test over this daemon's own composed catalog. |
| `daemon/src/test/daemon/gateway-ci-principals-channel-profiles-round-trip.test.ts` | PORT | End-to-end `ci.*`/`principals.*`/`channels.profiles.*` verb test over this daemon's composition. |
| `daemon/src/test/daemon/gateway-device-capability-verbs.test.ts` | PORT | Asserts the full `devices.*` verb family, including paired-phone round-trip verbs, is served. |
| `daemon/src/test/daemon/gateway-initiative-verbs.test.ts` | PORT | Asserts `principals.*`, `channels.profiles.*` and `ci.*` are present and invokable, not merely described. |
| `daemon/src/test/daemon/gateway-occasions-verbs.test.ts` | PORT | Asserts all seventeen `occasions.*` verbs are present and invokable. |
| `daemon/src/test/daemon/gateway-verb-family-parity.test.ts` | PORT | The verb-family oracle sweep, run at the process that actually serves the verbs. |
| `daemon/src/test/daemon/gateway-ws-only-invokable.test.ts` | PORT | Asserts every ws-only verb the daemon advertises is actually invokable (regression guard for descriptors-without-handlers). |
| `daemon/src/test/daemon/http-policy.test.ts` | PORT | Exercises SDK helpers for missing-scope bodies, authenticated-principal resolution and private-host fetch options; deterministic. |
| `daemon/src/test/daemon/lifecycle.test.ts` | PORT | Asserts `resolveDaemonUpdateArtifact`'s binary-vs-dev-install guard. |
| `daemon/src/test/daemon/local-daemon-state.test.ts` | PORT | Asserts the lifecycle-marker/receipts readers' parsing and bounds. |
| `daemon/src/test/daemon/pair-command.test.ts` | PORT | Exercises local reprint and remote mint-with-consent paths of `runPairCommand`. |
| `daemon/src/test/daemon/provider-registration.test.ts` | PORT | Asserts `registerDiscoveredProviders` idempotency against overlapping LAN-scan results. |
| `daemon/src/test/daemon/provision-wake-model.test.ts` | PORT | Asserts the provision command cannot be made to fail an installer regardless of outcome. |
| `daemon/src/test/daemon/safe-serve.test.ts` | PORT | Exercises the SDK's safe-host-serve factory and failure response builder. |
| `daemon/src/test/daemon/server.test.ts` | PORT | Integration test of `DaemonServer`/`HttpListener` composition. |
| `daemon/src/test/daemon/service-commands.test.ts` | PORT | Exercises install/uninstall/status result-line building against a real temp-rooted `ConfigManager`. |
| `daemon/src/test/daemon/service-lifecycle-commands.test.ts` | PORT | Exercises start/stop/restart lifecycle verbs and status exit codes. |
| `daemon/src/test/daemon/service-manager.test.ts` | PORT | Exercises the SDK's `PlatformServiceManager` directly against a temp root. |
| `daemon/src/test/daemon/sessions-command.test.ts` | PORT | Exercises `runSessionsCommand`'s list/kill dispatch and rendering. |
| `daemon/src/test/daemon/sqlite-store-recovery.test.ts` | PORT | Asserts the daemon's SQLite base store validates file content (not merely existence) before opening; exercises the handler-registration store (see Handler registration). |
| `daemon/src/test/daemon/standalone-routes.test.ts` | PORT | Integration tests for standalone-daemon route/panel-registry findings (companion-chat, provider discovery, panel registry, SSE domains). |
| `daemon/src/test/daemon/status-command.test.ts` | PORT | Exercises `runStatusCommand`/`runUpdateCommand` against stubbed routes and sockets. |
| `daemon/src/test/daemon/surface-dispatched-reply.test.ts` | PORT | Asserts a conversation dispatched to a surface still delivers its reply back to that channel. |
| `daemon/src/test/daemon/telemetry-routes.test.ts` | PORT | Exercises the SDK's telemetry route handlers against this daemon's runtime bus/store. |
| `daemon/src/test/daemon/webui-command.test.ts` | PORT | Asserts `webui enable` never widens network exposure as a side effect, among other webui-command properties. |

## Test infrastructure

| File | Disposition | Note |
|---|---|---|
| `daemon/src/test/deps/dependency-check.test.ts` | PORT | Verifies the local-tools and knowledge packages a hosted turn depends on (tree-sitter, sql.js, fuse.js, jszip) resolve and work. |
| `daemon/src/test/helpers/authenticated-websocket.ts` | PORT | Small test helper opening an authenticated WebSocket against a test daemon. |
| `daemon/src/test/helpers/config-manager-stub.ts` | PORT | A minimal `ConfigManager` stand-in for command-level tests. |
| `daemon/src/test/helpers/disposables.test.ts` | PORT | Guards the disposables-tracking and runtime-services-reset test scaffolding itself. |
| `daemon/src/test/helpers/disposables.ts` | PORT | Tracks and disposes resources a test starts, so nothing leaks between tests. |
| `daemon/src/test/helpers/liveness.ts` | PORT | Test helper for asserting process/service liveness. |
| `daemon/src/test/helpers/project-temp.test.ts` | PORT | Tests the temp-directory helper's placement and cleanup registration. |
| `daemon/src/test/helpers/project-temp.ts` | PORT | Creates a per-test temp project directory. |
| `daemon/src/test/helpers/provider-cache.ts` | PORT | Test helper for caching/stubbing provider registry state. |
| `daemon/src/test/helpers/runtime-services.ts` | PORT | Builds and resets a full test `RuntimeServices` graph for integration-style tests. |
| `daemon/src/test/helpers/session-surface.ts` | PORT | Small helper constructing a test session/surface pairing. |
| `daemon/src/test/helpers/settings-control-plane.ts` | PORT | Minimal control-plane settings stub for tests. |
| `daemon/src/test/helpers/temp-cleanup.test.ts` | PORT | Counts real temp directories after a child `bun test` process exits, proving the teardown preload actually drains the registry. |
| `daemon/src/test/helpers/temp-registry.ts` | PORT | Registry of temp directories created during a test run, drained at process exit. |
| `daemon/src/test/helpers/test-managers.ts` | PORT | Builds stub managers (config, secrets, etc.) shared across test files. |
| `daemon/src/test/preload/temp-cleanup.ts` | PORT | The `bun test` preload that drains the temp-directory registry on process exit. |
| `daemon/src/test/scripts/workflow-shape.test.ts` | PORT | Local proof that the hand-authored GitHub Actions workflow YAML is well-formed (job graphs, needs edges, timeout caps, pinned SHAs); structural YAML checks, not natural-language classification. |
| `daemon/src/test/setup.ts` | PORT | Bun test global setup (environment, mocks) shared by the whole suite. |
| `daemon/src/testing/daemon-fixture.ts` | PORT | Shared fixture composing a real test daemon instance for integration tests. |
| `daemon/src/testing/hosted-session-failures.ts` | PORT | Shared fixtures for hosted-session failure-path tests. |

## Packaging and tooling

| File | Disposition | Note |
|---|---|---|
| `daemon/.github/actions/setup/action.yml` | PORT | Composite CI action: pins Bun, restores its install cache, runs `bun install --frozen-lockfile`. Fixed YAML/shell mechanics, no guesswork. |
| `daemon/.github/workflows/ci.yml` | PORT | CI pipeline: typecheck, test, coverage ratchet, architecture check, publish-check, workflow-check, build, boot-smoke, and an auto-release job that tags and dispatches release.yml on green main. All fixed job graph and shell conditionals. |
| `daemon/.github/workflows/release.yml` | PORT | Release pipeline: tag-version verification, per-job-green re-verification, 4-target binary matrix, daemon and macOS smoke, npm-install smoke, release-asset staging, GitHub release, npm publish, GitHub Packages mirror. Fixed job graph. |
| `daemon/.gitignore` | PORT | Standard ignore list (build output, secrets, runtime state, test scratch). |
| `daemon/CHANGELOG.md` | PORT | Historical per-release changelog, prose entries describing shipped changes; a durable record, not a decision point. |
| `daemon/LICENSE` | PORT | MIT license text. |
| `daemon/README.md` | PORT | Project overview, install instructions, handler-family table, build and run instructions. |
| `daemon/bin/goodvibes-daemon` | PORT | Launcher shim: prefers a locally built or vendored binary, self-heals by downloading and checksum-verifying the release binary, falls back to running from source with `bun`. Deterministic file-existence and platform-name resolution, no guesswork. |
| `daemon/bin/launcher-support.js` | PORT | Helper functions for the launcher: resolves platform artifact names, downloads and checksum-verifies the binary and the sqlite-vec addon. Deterministic. |
| `daemon/bun.lock` | PORT | Bun lockfile; exact dependency resolution. |
| `daemon/bunfig.toml` | PORT | Bun test/coverage configuration: preload path, coverage reporter and ignore patterns. |
| `daemon/docs/commands-reference.md` | PORT | Hand-maintained reference for every CLI command, its flags, and exit codes. |
| `daemon/docs/configuration.md` | PORT | Reference for every settings key the daemon reads, including which are daemon-owned and which are redacted on read. |
| `daemon/docs/getting-started.md` | PORT | Install and first-boot walkthrough, state-location reference. |
| `daemon/docs/hosted-sessions.md` | PORT | Reference for daemon-hosted conversation sessions: verbs, detach/kill semantics, limits. |
| `daemon/docs/service-and-deployment.md` | PORT | Reference for the host service (systemd/launchd/Windows), unit locations, and the `migrate-service` takeover procedure. |
| `daemon/docs/troubleshooting.md` | PORT | Startup-failure, logging, and port-conflict troubleshooting reference. |
| `daemon/docs/updates-and-rollback.md` | PORT | Reference for the hourly self-update loop, `.previous` rollback, and automatic crash-loop rollback. |
| `daemon/package.json` | PORT | npm package manifest: scripts, dependencies, publish file list. |
| `daemon/scripts/boot-smoke.ts` | PORT | CI smoke test: boots the compiled binary against an isolated home, checks `/status`, the startup banner, loud failure on a broken settings file, and sqlite-vec-backed semantic search. Fixed string/substring checks against this project's own wire format (e.g. `looksLikeSqliteVecError` checking for the literal token `sqlite-vec` plus `error`/`fail`), not natural-language classification. |
| `daemon/scripts/bun-compile-compat.ts` | PORT | Prebuild step patching known Bun-compile incompatibilities in vendored dependencies (jsdom, sql.js, css-tree) via exact source-string replacement. |
| `daemon/scripts/check-architecture.ts` | PORT | CI static-analysis gate: source-line-count cap, pattern-based rules against source syntax (regexes matching code shapes like `process.cwd()` or `mkdtemp(tmpdir())`, not prose), explicit-`any` detection via the TS compiler API, import-cycle detection (Tarjan SCC), and layer-boundary rules. All rules operate over source code structure/syntax, not natural-language meaning. |
| `daemon/scripts/check-bun.sh` | PORT | `preinstall` guard: refuses install when `bun` is not on PATH. |
| `daemon/scripts/check-changelog.ts` | PORT | Verifies CHANGELOG.md has a section header matching package.json's version, via the shared toolchain gate. |
| `daemon/scripts/check-workflows.ts` | PORT | Structural validation of GitHub Actions workflow YAML (parses, checks required fields exist, bans job-level `continue-on-error`, checks the release workflow declares required jobs). Structural/schema checks over YAML keys, not free text. |
| `daemon/scripts/ci-publish.ts` | PORT | Idempotent npm publish from CI: checks whether the version is already served, publishes if not, re-checks after a failed publish for a race. |
| `daemon/scripts/coverage-gate.ts` | PORT | Aggregate whole-suite coverage gate: runs `bun test --coverage`, parses the summary via the shared toolchain parser, compares against ratchet floors from `toolchain.config.json`. |
| `daemon/scripts/hosted-session-proof.ts` | PORT | CI smoke test driving a full hosted-session lifecycle (create, steer, detach/kill under both policies, reattach, per-session override) against the compiled binary and a stub OpenAI-compatible model. |
| `daemon/scripts/postinstall.d.ts` | PORT | Type declarations for the plain-JS `postinstall.js`, re-exported from the SDK's self-update module so the two never disagree. |
| `daemon/scripts/postinstall.js` | PORT | npm postinstall: downloads and checksum-verifies the platform daemon binary and the sqlite-vec addon, skipping on a source checkout or `--no-download`. |
| `daemon/scripts/prebuild.ts` | PORT | Prebuild entry point: patches Bun-compile compatibility and syncs version surfaces, under a workspace lock. |
| `daemon/scripts/project-surfaces.ts` | PORT | Syncs the version number from package.json into `src/version.ts`'s fallback and the README badge via exact regex substitution on a fixed string shape (a version number and a badge URL pattern), not natural-language classification. |
| `daemon/scripts/publish-check.ts` | PORT | Pre-publish gate: shared SDK-pin tri-agreement, repo-specific required package.json fields, tarball path/size and bin-shim policy, and an npm registry auth probe. |
| `daemon/scripts/publish-github-mirror.ts` | PORT | Publishes a secondary GitHub Packages mirror of the npm package under a renamed scope, idempotently. |
| `daemon/scripts/release.ts` | PORT | Local release-cut wrapper: assembles the CHANGELOG body (from an explicit release-notes env var, refusing raw commit-hash lines, or falling back to the git log for dry runs) and invokes the shared `goodvibes-release-cut` tool. The commit-hash-line check (`/^- [0-9a-f]{7,40}\s/i`) is a fixed-shape guard against a specific known failure mode (a scratchpad path or commit log leaking into a changelog), not a natural-language judgment about note quality. |
| `daemon/scripts/run-tests.ts` | PORT | Parallel per-file test runner: isolates each test file's TMPDIR, sweeps stale scratch directories, applies an optional substring filter pattern from argv. |
| `daemon/scripts/sdk-dev.ts` | PORT | Thin forwarder to the canonical SDK-overlay dev tool in the sibling `goodvibes-sdk` checkout. |
| `daemon/scripts/stale-tmp-sweep.ts` | PORT | Age-gated cleanup of stale test-scratch directories, both under this repo's `.test-tmp` and (by an exact, enumerated prefix list) under the real OS temp directory. Exact-prefix matching, not a heuristic guess. |
| `daemon/scripts/test-pattern-rule.ts` | PORT | Pure argv-parsing helper: extracts the optional test-file substring filter from `run-tests.ts`'s command line, skipping known flags. |
| `daemon/scripts/test-temp-manifest.ts` | PORT | Handover mechanism between a finished test process and the runner: reads/writes a JSON manifest of temp directories the child owned, so the parent can remove them after exit. |
| `daemon/scripts/verify-release-tag-version.ts` | PORT | Verifies the pushed/dispatched git tag equals `v${package.json version}`, exact string comparison. |
| `daemon/scripts/workspace-lock.ts` | PORT | File-based mutual-exclusion lock (with staleness detection by age and by checking whether the owning pid is still alive) guarding prebuild against concurrent invocations. |
| `daemon/toolchain.config.json` | PORT | Shared-toolchain configuration: build targets, coverage floors, publish policy, release-cut settings. |
| `daemon/tsconfig.json` | PORT | TypeScript compiler configuration for the main source tree. |
| `daemon/tsconfig.test.json` | PORT | TypeScript compiler configuration for the test tree (extends the main config). |

## Handler registration

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/context.ts` | PORT | The `HandlerContext`/`HandlerLogger`/`SurfaceRegister` shapes every surface register function takes; pure type definitions. |
| `daemon/src/daemon/handlers/contracts.ts` | PORT | The single SDK-contract import seam for the handler layer: re-exports gateway catalog/invocation types and the payments/remote-route contracts so no other handler file re-declares an SDK id or schema. |
| `daemon/src/daemon/handlers/credentials.ts` | HOIST | Engine subsystem: config. `DaemonCredentialStore` (resolve a `goodvibes://secrets/` reference or config-derived secret, write a daemon-scoped credential) and `createAtRestCipher` (AES-256-GCM at-rest encryption for draft bodies, keyed off a lazily-generated store key) are general secret-resolution and at-rest-encryption capability, not daemon-specific routing; every HOIST surface (drafts, inbox, payments, routing) imports its `DaemonCredentialStore` type, so hoisting it alongside the engine's secrets/secret-refs keeps one definition. Deterministic; no guesswork. |
| `daemon/src/daemon/handlers/errors.ts` | PORT | `HandlerError` (message, machine code, HTTP status) and the `REQUIRE_CONFIRM` code; a plain typed error class, not a decision point (fixed status/code mapping). |
| `daemon/src/daemon/handlers/index.ts` | PORT | Composition root for the handler layer: assembles routing, inbox(+triage), drafts, payments and remote onto the gateway catalog in a fixed order and returns one teardown plus the cross-surface handles the runtime needs. |
| `daemon/src/daemon/handlers/register.ts` | PORT | `registerCatalogHandler`/`registerCatalogHandlers`, the linchpin binding a typed host handler to an SDK-registered gateway method descriptor by id, `normalizeContext`, and `assertConfirmed`'s fixed `body.confirm === true` check. Pure structural wiring. |
| `daemon/src/daemon/handlers/sqlite-store.ts` | PORT | `HandlerSqliteStore`: sql.js-backed store lifecycle (init, quarantine-on-corruption by SQLite header/byte validation, atomic save, transaction). Deterministic file-format validation, not a decision point. |

## Runtime composition

| File | Disposition | Note |
|---|---|---|
| `daemon/src/runtime/boot-tasks.ts` | PORT | `runDaemonBootTasks`: the boot steps this product owns (legacy memory fold, provider health watch, webhook notifier attach, configured-service integration sync, plugin load), each best-effort. |
| `daemon/src/runtime/browser-checkout-seam-holder.ts` | PORT | A mutable holder (get/set/clear) for the `BrowserCheckoutSeam` that arrives asynchronously after the payments handlers are constructed; pure closure-over-a-variable wiring. |
| `daemon/src/runtime/cluster-composition.ts` | PORT | Builds this daemon's `ClusterCoordinator` (LAN leader election) and the per-account `inboxPollerGate`; deterministic settings/state-path wiring. |
| `daemon/src/runtime/cluster-group-composition.ts` | PORT | Builds the LAN group layer (`ClusterGroupRuntime`, transport, verbs) and `announceReturn`'s rejoin-on-start logic; all state-machine/signature checks over structured protocol replies, not natural-language guesswork. |
| `daemon/src/runtime/conversation-rewind-port.ts` | PORT | `createConversationRewindPort` and the live per-session conversation registry backing the daemon's rewind fallback; deterministic message-count/truncation logic. |
| `daemon/src/runtime/credential-composition.ts` | PORT | `composeCredentialServices`: constructs the `SecretsManager`, `StepUpService` and `PairingTokenManager` from threaded (never defaulted) home directories. Pure construction. |
| `daemon/src/runtime/daemon-handler-composition.ts` | PORT | `createDaemonHandlerComposition`: builds the `HandlerContext` and wires routing/inbox/triage/drafts/payments/remote providers into `registerDaemonHandlers`, including handing the inbox poller to cluster leadership. |
| `daemon/src/runtime/device-posture-composition.ts` | PORT | Builds the paired-phone device-posture runtime and its housekeeping sweep; wires the platform-owned `platform/devices` capability to this daemon's transport/approvals/storage seams. |
| `daemon/src/runtime/disposal-wiring.ts` | PORT | `registerDaemonRuntimePollers`: maps the daemon's assembled graph onto the SDK's disposal registry, plus the four daemon-only pollers (crash-residue, device housekeeping, wake-model recovery, handler surfaces). Deterministic teardown ordering. |
| `daemon/src/runtime/fleet-needs-input-push.ts` | PORT | `wireFleetNeedsInputPush`: attaches the fleet emit-bridge and builds a session-presence lookup (`hasFreshSurfaceParticipant`) for the needs-input browser-push source; a freshness-window timestamp comparison, not text classification. |
| `daemon/src/runtime/fleet-services.ts` | PORT | `createFleetServices`: builds the shared archive-aware fleet registry plus the daemon-side observed-foreign-agent source and the one honest pricing resolver. |
| `daemon/src/runtime/hosted-session-composition.ts` | PORT | `createHostedSessionOptions`: states the fixed `conversational` exec posture for every daemon-hosted session and builds the per-workspace trust-gated floor factory; a hardcoded posture return, not a guess. |
| `daemon/src/runtime/index.ts` | PORT | Runtime barrel: re-exports the SDK's runtime namespace symbols the daemon composition uses. No behavior of its own. |
| `daemon/src/runtime/knowledge-services.ts` | PORT | `createKnowledgeServices`: constructs the three `KnowledgeStore`s, their semantic/ingest services and the project-planning/work-plan stores with memory-governor backpressure wired in. Composition only; the knowledge stack's own judgment logic lives in the engine (see engine.md's knowledge subsystem) and is unaffected by this wiring. |
| `daemon/src/runtime/legacy-daemon-migration.ts` | PORT | Builds and runs the consented, guided migration of the install-script `goodvibes-daemon.service` systemd unit to the managed `goodvibes.service` unit (new-up-then-old-down, never auto-migrate). Every check is an exact-string unit-name/marker match or a systemctl status/PID probe; no WRFC or QEMU content, so the intent's DROP call for this file is void per the project's disposition rule; nothing here is a decision point. |
| `daemon/src/runtime/legacy-daemon-reconcile.ts` | PORT | `reconcileRedundantLegacyUnit`: the unattended boot-time reconcile that auto-retires an installer-marker-managed, enabled-but-idle legacy unit once the canonical unit is confirmed active and serving. Every guard is a systemctl status/PID/marker-string check (`INSTALLER_UNIT_MARKER` exact match), not natural-language classification; same override as its sibling file, not WRFC/QEMU-specific. |
| `daemon/src/runtime/mail-composition.ts` | PORT | `composeMailDeps`: builds the `EmailServiceDeps` and not-configured describer the platform's `email.*` verbs need, from this daemon's own `surfaces.email.*` config keys. |
| `daemon/src/runtime/notification-dispatch.ts` | PORT | `wireMemoryPressureChannelNotice`: bridges one targeted runtime-bus event (`OPS_MEMORY_PRESSURE`) to the operator's configured notice channel, logging at a severity derived from the payload's own numeric level. No guesswork. |
| `daemon/src/runtime/payments-composition.ts` | PORT | `createPaymentsServices`: composes the daemon's card/purchase/budget/approval/journal stores and the checkout pair, wiring `createModelMerchantJudge`/`createProviderBackedMerchantJudgeModel` from the engine (already JEV there, see engine.md) rather than deciding anything itself. |
| `daemon/src/runtime/plugin-composition.ts` | PORT | `createDaemonPluginLoaderDeps`: the daemon's half of plugin loading (verb-side registries served, surface-side registries accepted-and-logged rather than silently dropped). Deterministic dispatch by fixed capability kind. |
| `daemon/src/runtime/runtime-services-types.ts` | PORT | `RuntimeServicesOptions`/`RuntimeServices` type definitions only; no runtime code. |
| `daemon/src/runtime/services.ts` | PORT | `createRuntimeServices`, the daemon's one composition root; ~800 lines of dependency-injected construction calls. No text/keyword classification anywhere in it. |
| `daemon/src/runtime/trigger-services.ts` | PORT | `createTriggerServices`: composes the `TriggerManager` (stream watchers, on-exit process triggers, condition checks) from live config reads. |
| `daemon/src/runtime/trust/checkpoint-eligibility.ts` | PORT | Synchronous reader of the shared workspace-registration store, resolving whether a path is checkpoint-eligible; deterministic JSON parsing and worktree-link resolution, no guesswork. Daemon-specific composition rather than general engine capability, so it stays rather than hoisting. |
| `daemon/src/runtime/trust/trust-gated-approvals.ts` | HOIST | Engine subsystem: gate. `createWorkspaceTrustDecisionAsk` and `trustGatedApprovalRaiser` put the workspace-trust question in front of every ask a hosted run makes, raising it as an ordinary approval record. Pure wiring around the engine's own `trustGatedAsk`/`WorkspaceTrustManager` (`platform/runtime` operations); no keyword/regex/score classification, so no decision points. Belongs beside the gate's other approval-boundary wiring rather than staying daemon-local. |
| `daemon/src/runtime/update-check.ts` | PORT | Re-exports the SDK's version-comparison/release-tag helpers and adds `detectInstallKind`, a fixed match on `process.execPath` segments (`bun`/`bun.exe`, `node_modules`) to tell a compiled binary from a package install from a source run. Exact machine-format matching, not a decision point. |
| `daemon/src/runtime/workspace-checkpointing.ts` | PORT | `createWorkspaceCheckpointing`: gates the `WorkspaceCheckpointManager`'s automatic snapshots on the live registered-workspaces-only ruling; deterministic boolean gate. |
| `daemon/src/test/daemon/handlers/register.test.ts` | PORT | Exercises `registerCatalogHandler`/`registerCatalogHandlers`. |
| `daemon/src/test/runtime/cluster-holdings-wiring.test.ts` | PORT | Exercises cluster-group/coordinator composition wiring. |
| `daemon/src/test/runtime/cluster-inbox-gating.test.ts` | PORT | Exercises the inbox poller's cluster-leadership gating. |
| `daemon/src/test/runtime/composition-parity.test.ts` | PORT | Exercises `services.ts`'s composition surface for parity. |
| `daemon/src/test/runtime/control-plane-store-location.test.ts` | PORT | Exercises control-plane store path scoping. |
| `daemon/src/test/runtime/control-plane-store-writes.test.ts` | PORT | Exercises control-plane store write behavior. |
| `daemon/src/test/runtime/daemon-unification.test.ts` | PORT | Exercises the unified daemon composition. |
| `daemon/src/test/runtime/device-posture-key-governance.test.ts` | PORT | Exercises device-posture-composition.ts's key governance. |
| `daemon/src/test/runtime/exec-prompt-answer-wiring.test.ts` | PORT | Exercises `execPromptAnswerHandler` wiring in services.ts. |
| `daemon/src/test/runtime/hosted-exec-posture.test.ts` | PORT | Exercises hosted-session-composition.ts's fixed `conversational` exec posture. |
| `daemon/src/test/runtime/hosted-sessions.test.ts` | PORT | Exercises hosted-session-composition.ts. |
| `daemon/src/test/runtime/localhost-fetch-approval-wiring.test.ts` | PORT | Exercises `localhostFetchApproval` wiring in services.ts. |
| `daemon/src/test/runtime/memory-fold.test.ts` | PORT | Exercises the legacy memory-store boot fold in boot-tasks.ts. |
| `daemon/src/test/runtime/memory-governance-composition.test.ts` | PORT | Exercises `wireDaemonMemoryGovernance` composition in services.ts. |
| `daemon/src/test/runtime/notification-dispatch.test.ts` | PORT | Exercises `wireMemoryPressureChannelNotice`. |
| `daemon/src/test/runtime/personal-capture-wiring.test.ts` | PORT | Exercises the `PersonalCaptureHolder` wiring in services.ts. |
| `daemon/src/test/runtime/plugin-composition.test.ts` | PORT | Exercises `createDaemonPluginLoaderDeps`. |
| `daemon/src/test/runtime/trust-gated-approvals.test.ts` | HOIST | Exercises trust-gated-approvals.ts; follows that file to the gate subsystem. |
| `daemon/src/test/daemon/gateway-fleet-needs-input-push.test.ts` | PORT | Pins that `src/runtime/fleet-needs-input-push.ts`'s fan-out is real end to end (a synthetic fleet-blocked envelope reaches the push service). Follows that runtime-composition file's disposition (PORT), not this batch's surfaces. |
| `daemon/src/test/daemon/gateway-hosted-session-failures.test.ts` | PORT | Pins the four honest refusal shapes for `sessions.hosted.*` against `src/testing/hosted-session-failures.ts`'s fixtures. Follows hosted-session-composition's disposition (PORT). |
| `daemon/src/test/daemon/gateway-rewind-conversation-scope.test.ts` | PORT | Pins that `src/runtime/conversation-rewind-port.ts` serves live conversation-scope rewind over the composed gateway. Follows that file's disposition (PORT). |

## Drafts

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/drafts/draft-store.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. The Draft Sync Backend SQLite store: server-side mirror of the agent's local `channels/drafts.json`, plain upsert with most-recent-updatedAt-wins, body encrypted at rest, webhook always redacted on read. No guesswork; hoists to the engine's channels subsystem (the intent names drafts as hoisted there). |
| `daemon/src/daemon/handlers/drafts/index.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. Barrel re-exporting the register entrypoint and the store/types. |
| `daemon/src/daemon/handlers/drafts/register.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. Attaches the four `channels.drafts.*` handlers to the SDK-registered descriptors; strict input validation (ISO-8601 anchoring, webhook-redaction enforcement) is all deterministic shape checking, not guesswork. |
| `daemon/src/test/daemon/drafts/draft-store.test.ts` | HOIST | Exercises `DraftSyncStore`; follows draft-store.ts. |
| `daemon/src/test/daemon/drafts/register.test.ts` | HOIST | Exercises the `channels.drafts.*` handlers; follows register.ts. |

## Inbox

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/inbox/aggregator.ts` | HOIST | Engine subsystem: intake. Merges the synced-mirror feed into one paginated, cursor-based page and attaches every provider's live standing (`wireState` maps the poller's internal state to ready/empty/unconfigured/error/pending by fixed structural rules, not text). No guesswork. |
| `daemon/src/daemon/handlers/inbox/cursor-store.ts` | HOIST | Engine subsystem: intake. SQLite-backed persistent cursor + item store for the inbound feed, with age-TTL and count-cap retention. Deterministic bookkeeping. |
| `daemon/src/daemon/handlers/inbox/index.ts` | HOIST | Engine subsystem: intake. Registers `channels.inbox.list`, wires builtin provider adapters, cursor store, poller and (optionally) a leadership gate. |
| `daemon/src/daemon/handlers/inbox/mapping.ts` | HOIST | Engine subsystem: intake. Pure redaction/preview helpers: PII/secret stripping by fixed regex over structured formats (email, phone, JWT, provider-key prefixes, bearer tokens) and HTML/MIME de-structuring. This is deterministic security-adjacent redaction against fixed machine formats (matching the intent's card-shape-scanner carve-out), not natural-language classification, so it is not a decision point. |
| `daemon/src/daemon/handlers/inbox/poller.ts` | HOIST | Engine subsystem: intake. Runs one polling interval per provider, dedups, persists, and reports per-provider status; a bad provider degrades to `unavailable` rather than crashing the loop. Deterministic. |
| `daemon/src/daemon/handlers/inbox/provider-adapter.ts` | HOIST | Engine subsystem: intake. The adapter contract and factory registry every inbound provider implements. |
| `daemon/src/daemon/handlers/inbox/providers/discord.ts` | HOIST | Engine subsystem: intake. Discord DM-polling adapter over the REST API. `classifyDiscordKind` picks reaction/mention/thread/dm by structured fields (author id equality, a `mentions[]` array containing self id, `referenced_message` presence), a fixed most-specific-first ladder over booleans, not natural-language guesswork, so it is not a decision point. |
| `daemon/src/daemon/handlers/inbox/providers/email.ts` | HOIST | Engine subsystem: intake. IMAP inbound adapter over the dependency-free `ImapClient`. Deterministic credential resolution and paging. |
| `daemon/src/daemon/handlers/inbox/providers/imap-client.ts` | HOIST | Engine subsystem: intake. Minimal dependency-free IMAPS client (RFC 3501 subset). Fixed-grammar protocol parsing (regexes match IMAP's own wire syntax, e.g. `UID (\d+)`, tagged-response markers), not natural-language guesswork. |
| `daemon/src/daemon/handlers/inbox/providers/route-util.ts` | HOIST | Engine subsystem: intake. Shared best-effort route-resolution wrapper; swallows resolver failures. |
| `daemon/src/daemon/handlers/inbox/providers/slack.ts` | HOIST | Engine subsystem: intake. Slack DM-polling adapter over the Web API. `classifySlackKind` uses the same structured-field ladder as Discord's (self user id equality, an `<@SELF>` mention token match, `thread_ts` presence); the mention check is a literal substring test for a known-format Slack mention token, not free-text classification. Not a decision point. |
| `daemon/src/test/daemon/inbox/aggregator.test.ts` | HOIST | Follows aggregator.ts. |
| `daemon/src/test/daemon/inbox/cursor-store.test.ts` | HOIST | Follows cursor-store.ts. |
| `daemon/src/test/daemon/inbox/mapping.test.ts` | HOIST | Follows mapping.ts. |
| `daemon/src/test/daemon/inbox/poller.test.ts` | HOIST | Follows poller.ts. |
| `daemon/src/test/daemon/inbox/register.test.ts` | HOIST | Follows index.ts's registration. |
| `daemon/src/test/daemon/gateway-inbox-list-reachable.test.ts` | HOIST | Pins that `channels.inbox.list` is reachable over the composed gateway; follows the inbox surface. |

## Payments

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/payments/address-store.ts` | HOIST | Engine subsystem: payments. Reads the owner's stored shipping/billing addresses from config; blank-field handling only, no guesswork. |
| `daemon/src/daemon/handlers/payments/approval-store.ts` | HOIST | Engine subsystem: payments. The persisted, single-use, content-bound owner-approval store a checkout spends. `closerMismatch`'s ranking of mismatch kinds is a fixed lookup table over closed enum values, not a judged reading. Deterministic durability/security bookkeeping. |
| `daemon/src/daemon/handlers/payments/budget-store.ts` | HOIST | Engine subsystem: payments. `DurableBudgetLedger`, a durable subclass of the SDK's `BudgetLedger` adding write-through persistence. Pure money arithmetic and validation (finite/integer/range checks); stays code per the intent's deterministic-boundary rule. |
| `daemon/src/daemon/handlers/payments/card-store.ts` | HOIST | Engine subsystem: payments. The daemon's card metadata file plus secret-tier material split. `cardBrand()` maps a card number's leading digits to a brand via fixed IIN/BIN-range regexes (an industry-standard structured code lookup, not natural-language guesswork), consistent with the intent's fixed-format carve-out. Not a decision point. |
| `daemon/src/daemon/handlers/payments/checkout-handlers.ts` | HOIST | Engine subsystem: payments. `payments.checkout.begin` / `.approve` / `.fillCard` local wrappers: strict wire-shape parsing, the per-invocation gate-input cell, and the owner-approval consumption/refusal-message selection (a fixed switch over closed mismatch enum values). All deterministic; no guesswork. |
| `daemon/src/daemon/handlers/payments/checkout-journal-store.ts` | HOIST | Engine subsystem: payments. Durable, append/remove `CheckoutJournal` implementation guaranteeing a `submit-pending` record survives a crash. Deterministic. |
| `daemon/src/daemon/handlers/payments/index.ts` | HOIST | Engine subsystem: payments. Barrel export for the payments surface. |
| `daemon/src/daemon/handlers/payments/merchant-judge.ts` | HOIST | Engine subsystem: payments. Adapts this daemon's `ProviderRegistry` to the engine's `MerchantJudgeModel.chat` seam (resolve current model, call its provider, treat any failure as "unjudged"). The actual merchant-qualification guesswork (a prompt built from a fixed criterion, parsed into qualifies/confident/recourse/marketplace) lives in the engine's already-JEV `sdk/src/platform/payments/merchant-judge-model.ts`, which this file feeds; this daemon file itself contains no guessed classification, only provider-registry wiring. |
| `daemon/src/daemon/handlers/payments/notifier.ts` | HOIST | Engine subsystem: payments. Adapts this daemon's `ChannelDeliveryRouter` to the engine's `PaymentNotifier` seam. The reply-reading guesswork (approve/deny keyword maps) lives in the engine's already-JEV `sdk/src/platform/payments/notice-delivery.ts`; this file supplies only channel routing and a not-yet-wired `waitForAnswer` stub (documented as intentional: silence is the correct fallback, not a stand-in for missing judgment). No guesswork of its own. |
| `daemon/src/daemon/handlers/payments/purchase-ledger.ts` | HOIST | Engine subsystem: payments. Append-only audit ledger behind `payments.purchases.list`. Deterministic file store. |
| `daemon/src/daemon/handlers/payments/register.ts` | HOIST | Engine subsystem: payments. Attaches the eight `payments.*` handlers (budget/cards/purchases/checkout-approve), narrowing input validation beyond the SDK's own generic route handlers. All deterministic field/shape checks (digit counts, integer ranges, CVV digit patterns); no guesswork. |
| `daemon/src/test/daemon/payments/approval-store.test.ts` | HOIST | Follows approval-store.ts. |
| `daemon/src/test/daemon/payments/budget-store.test.ts` | HOIST | Follows budget-store.ts. |
| `daemon/src/test/daemon/payments/card-store.test.ts` | HOIST | Follows card-store.ts. |
| `daemon/src/test/daemon/payments/checkout-journal-store.test.ts` | HOIST | Follows checkout-journal-store.ts. |
| `daemon/src/test/daemon/payments/purchase-ledger.test.ts` | HOIST | Follows purchase-ledger.ts. |
| `daemon/src/test/daemon/payments/register.test.ts` | HOIST | Follows register.ts. |
| `daemon/src/test/daemon/gateway-payments-verbs.test.ts` | HOIST | Pins the composed `payments.*` verb family over the gateway; follows the payments surface as a whole. |

## Routing

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/routing/inbox-bridge.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. Bridges an inbound item's `{provider, routeId}` to the routing resolver's `{surfaceKind, routeId}` lookup. Pure structural mapping, never throws; no guesswork. |
| `daemon/src/daemon/handlers/routing/index.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. Attaches `channels.routing.list/assign/delete` to the SDK descriptors. |
| `daemon/src/daemon/handlers/routing/route-store.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. SQLite-backed store for channel-to-profile routing assignments; composite-key parsing is fixed string-splitting on the first colon, not guesswork. |
| `daemon/src/daemon/handlers/routing/routing-resolver.ts` | HOIST | Engine subsystem: channels, adapters, channel profiles, channel sync. `resolveProfile`: a fixed three-step precedence lookup (exact match, surface-only, wildcard) over structured route records. Deterministic; no guesswork. |
| `daemon/src/test/daemon/routing/helpers.ts` | HOIST | Shared test helpers for the routing suite. |
| `daemon/src/test/daemon/routing/register.test.ts` | HOIST | Follows routing/index.ts. |
| `daemon/src/test/daemon/routing/route-store.test.ts` | HOIST | Follows route-store.ts. |
| `daemon/src/test/daemon/routing/routing-resolver.test.ts` | HOIST | Follows routing-resolver.ts. |

## Triage

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/triage/index.ts` | HOIST | Engine subsystem: intake. Public barrel for the triage surface (scorer, pipeline, tagger, integration). |
| `daemon/src/daemon/handlers/triage/integration.ts` | HOIST | Engine subsystem: intake. Decorates the inbox surface's `channels.inbox.list` handler to overlay persisted triage metadata; a catalog proxy, not a classifier itself. |
| `daemon/src/daemon/handlers/triage/pipeline.ts` | HOIST | Engine subsystem: intake. Persists each item's `scoreInboundItem` result (scorer.ts) into a dedicated SQLite store and overlays it back onto listed items. The scoring guesswork lives in scorer.ts (below); this file's own logic is storage bookkeeping. |
| `daemon/src/daemon/handlers/triage/scorer.ts` | HOIST | Engine subsystem: intake. The email auto-tag / spam-triage scorer: two hand-tuned keyword/phrase lexicons with per-term log-likelihood weights (`SPAM_TERMS`, lines 43-84; `PRIORITY_TERMS`, lines 87-117), combined with a hand-tuned bias term, capitalization ratio, URL density and punctuation signals into a logistic score, then labelled spam/priority/normal against hand-tuned thresholds (`DEFAULT_SPAM_THRESHOLD = 0.65`, `DEFAULT_PRIORITY_THRESHOLD = 0.6`, lines 39-40) in `scoreInboundItem` (lines 208-275). This is the intent's named "triage scorer... becomes the intake battery." See decision points below. |
| `daemon/src/daemon/handlers/triage/tagger/discord.ts` | HOIST | Engine subsystem: intake. Applies triage tags as real Discord forum-thread tags or a reaction analog. `resolveDiscordTagIds` is a fixed map lookup (triage tag string -> configured Discord snowflake id), not guesswork. |
| `daemon/src/daemon/handlers/triage/tagger/imap.ts` | HOIST | Engine subsystem: intake. Applies a triage tag as an IMAP keyword flag over a minimal IMAP4rev1-over-TLS client; CRLF-injection guards and retry-on-transient-error classification are deterministic (error code / exception-shape checks), not text guesswork. |
| `daemon/src/daemon/handlers/triage/tagger/index.ts` | HOIST | Engine subsystem: intake. Composes the per-provider taggers behind one `TriageTagger.applyTags`, gated by a config flag and confirmation. |
| `daemon/src/daemon/handlers/triage/tagger/shared.ts` | HOIST | Engine subsystem: intake. Shared tagger types and helpers. `slackEmojiForTag`/`discordEmojiForTag` match against the FIXED, internally generated tag string (`labelToTag`'s own output, e.g. `'GoodVibes/Spam'`), a closed-set lookup over a code-produced identifier, not a judged reading of free text. Not a decision point. |
| `daemon/src/daemon/handlers/triage/tagger/slack.ts` | HOIST | Engine subsystem: intake. Applies a triage tag as a Slack reaction. Deterministic HTTP call and status handling. |
| `daemon/src/daemon/handlers/triage/types.ts` | HOIST | Engine subsystem: intake. Daemon-internal triage domain types. |
| `daemon/src/test/daemon/triage/helpers.ts` | HOIST | Shared test helpers for the triage suite. |
| `daemon/src/test/daemon/triage/imap-client.test.ts` | HOIST | Follows the IMAP tagger/client path. |
| `daemon/src/test/daemon/triage/integration.test.ts` | HOIST | Follows integration.ts. |
| `daemon/src/test/daemon/triage/pipeline.test.ts` | HOIST | Follows pipeline.ts. |
| `daemon/src/test/daemon/triage/scorer.test.ts` | HOIST | Follows scorer.ts; its fixture cases (spam/priority/normal message texts) are exactly the behaviour the intake battery must reproduce. |
| `daemon/src/test/daemon/triage/tagger.test.ts` | HOIST | Follows the tagger composition. |

### Decision points

| Where | Guessed today | Replaced by |
|---|---|---|
| `daemon/src/daemon/handlers/triage/scorer.ts:43` | `SPAM_TERMS`, a 39-entry hand-tuned keyword/phrase-to-log-likelihood-weight map (`viagra` 3.2, `lottery` 2.8, `act now` 2.2, `wire transfer` 2.6, `verify your account` 2.6, and so on), summed by `countLexicon` against an item's lowercased subject+snippet text | coarsen pattern: classify the item's text into a small closed set of labels (spam / priority / normal), replacing the hand-tuned lexicon-and-threshold accumulation with a single reading |
| `daemon/src/daemon/handlers/triage/scorer.ts:87` | `PRIORITY_TERMS`, a 28-entry hand-tuned keyword/phrase-to-log-likelihood-weight map (`urgent` 2.4, `deadline` 2.0, `escalation` 2.2, `emergency` 2.6, `payment due` 2.0, and so on), summed the same way against the same text | folded into the same coarsen reading as SPAM_TERMS above: one battery answers spam / priority / normal for the item, rather than two independent lexicon scores compared against each other |
| `daemon/src/daemon/handlers/triage/scorer.ts:39-40,208-268` | `DEFAULT_SPAM_THRESHOLD = 0.65` and `DEFAULT_PRIORITY_THRESHOLD = 0.6`, hand-tuned cutoffs a sigmoid-squashed log-likelihood must clear to assign a label, plus the hand-tuned bias terms (`spamLL = -2.4`, `priorityLL = -2.2`) and secondary signal weights (capitalisation ratio, URL density, trailing question mark, `conversationKind === 'direct'`) that shift the score before the threshold comparison | the coarsen battery's band replaces the hand-tuned threshold pair: act/confirm/escalate-style bands scaled to stakes decide spam vs priority vs normal, with the deterministic structural signals (direct conversation, unread) kept as inputs the battery is given, not separately weighted numbers |

## Remote execution

| File | Disposition | Note |
|---|---|---|
| `daemon/src/daemon/handlers/remote/backends/cloud-terminal.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Runs a command in a managed cloud shell/VM via gcloud/aws/az CLIs, writing the resolved provider credential to a private, single-use 0600 file (never argv) and sweeping it on completion and on crash-window recovery. Backend selection is by fixed `config.provider` enum switch, not guesswork. |
| `daemon/src/daemon/handlers/remote/backends/docker.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Runs `docker exec` against a configured container, resolving `DOCKER_HOST` from the credential store when it is a secret reference. Deterministic argv construction. |
| `daemon/src/daemon/handlers/remote/backends/index.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Builds the fixed backendKind-to-Backend map (local-process, docker, ssh, cloud-terminal). |
| `daemon/src/daemon/handlers/remote/backends/local-process.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Tokenizes a command string (quote/escape aware, a fixed grammar, not natural-language parsing) and spawns it directly, honoring an optional executable allowlist. |
| `daemon/src/daemon/handlers/remote/backends/process-runner.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Shared `Bun.spawn` wrapper capturing stdout/stderr/exit code with a hard timeout; success/failure is read from the real exit code and a timeout flag, never from output text. |
| `daemon/src/daemon/handlers/remote/backends/ssh.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Runs a command over `ssh` with a pooled, per-peer identity key written to a private file and an OpenSSH ControlMaster multiplex; deterministic argv and cleanup. |
| `daemon/src/daemon/handlers/remote/backends/types.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Shared Backend/BackendContext/DispatchPayload types, the timeout resolver, and the remote-shell command composer (string concatenation by contract, not a guess). |
| `daemon/src/daemon/handlers/remote/dispatcher.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Routes `remote.peers.invoke` to the correct backend purely by the peer's stored `backendKind` enum field; truncates stdout/stderr to a fixed preview length and records a SHA-256 digest. No text-based routing. |
| `daemon/src/daemon/handlers/remote/index.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. Composition root wiring the peer registry, dispatcher, and the SDK's `DistributedRuntimeManager` into the `remote.peers.*` surface, plus best-effort teardown of ephemeral key/credential files. |
| `daemon/src/daemon/handlers/remote/peer-registry.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. SQLite-backed peer registry; validates and normalizes each peer's backendConfig (rejecting raw embedded credentials in favor of `goodvibes://secrets/` references) by fixed field/shape rules, a security check, not a judged classification. |
| `daemon/src/daemon/handlers/remote/service.ts` | HOIST | Engine subsystem: companion, push, pairing, relay, remote access. `HostDistributedRuntime`, a thin adapter passing typed calls through to the SDK's `DistributedRuntimeManager` plus the dispatcher's `invokePeer`; no decisions of its own. |
| `daemon/src/test/daemon/remote/backends.test.ts` | HOIST | Exercises the four backend implementations (tokenization, argv construction, credential file handling); follows the backends' HOIST. |
| `daemon/src/test/daemon/remote/dispatcher.test.ts` | HOIST | Exercises `RemoteDispatcher` routing, truncation and digesting; follows dispatcher.ts's HOIST. |
| `daemon/src/test/daemon/remote/index.test.ts` | HOIST | Exercises the remote surface composition root; follows index.ts's HOIST. |
| `daemon/src/test/daemon/remote/peer-registry.test.ts` | HOIST | Exercises peer registration, validation and corrupt-row handling; follows peer-registry.ts's HOIST. |
| `daemon/src/test/daemon/remote/route-gating.test.ts` | HOIST | Proves the SDK's admin gate short-circuits `invokePeer` and that remote-shell args pass through verbatim; follows the remote surface's HOIST. |
| `daemon/src/test/daemon/remote/service.test.ts` | HOIST | Exercises `HostDistributedRuntime`'s pass-through to a fake manager and dispatcher; follows service.ts's HOIST. |

## Cluster call plumbing

| File | Disposition | Note |
|---|---|---|
| `daemon/src/cluster/daemon-ws-call.ts` | HOIST | Engine subsystem: cluster. Calls a ws-only control-plane verb (the `sessions.hosted.*` family) over the same operator-token convention as the REST path; every outcome (auth refusal, 404, timeout, close) is read from the wire protocol's own typed `type`/`status` fields, not from free text. |
| `daemon/src/cluster/raw-reply-route.ts` | HOIST | Engine subsystem: cluster. Restates the three raw-answering routes (`/status`, `/api/health`, `/api/channels/status`) into the wrapped `{ok,data}` envelope every other cluster route uses; which routes are raw is a fixed, stated list, never sniffed from the payload. |
| `daemon/src/test/cluster/commands.test.ts` | HOIST | Exercises the `cluster` CLI subcommands and pins that they hold no cluster logic of their own (parse, one verb call, render); follows the cluster call plumbing's HOIST. |
| `daemon/src/test/cluster/daemon-ws-call.test.ts` | HOIST | Exercises `callDaemonWsVerb`'s auth/response/error/timeout/close handling; follows daemon-ws-call.ts's HOIST. |
| `daemon/src/test/cluster/raw-reply-route.test.ts` | HOIST | Exercises `callDaemonRoute`'s wrapped vs raw envelope handling; follows raw-reply-route.ts's HOIST. |
