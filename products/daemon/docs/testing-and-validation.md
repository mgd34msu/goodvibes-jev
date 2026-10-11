# Testing and validation

This workspace uses Bun 1.3.14 and Node 22 or later. Run from the repository with
its installed workspace dependencies and engine build. The [product manifest](../package.json)
and [root manifest](../../../package.json) are the command authority; commands from
the former standalone repository are not interchangeable with these scripts.

## Local commands

From the repository root:

```sh
bun install --frozen-lockfile
bun run build
bun run --cwd products/daemon typecheck
bun run --cwd products/daemon test
```

The product `build` emits JavaScript and declarations; it is not a native binary
build. Product `test` first builds that product and then invokes the official
[engine runner](../../../packages/engine/scripts/test.ts) with the daemon cwd.
To run a focused suite after building its prerequisites:

```sh
bun packages/engine/scripts/test.ts --cwd ../../products/daemon src/test/cli/parser.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/daemon src/test/daemon/config-command.test.ts
bun packages/engine/scripts/test.ts test/hosted-initial-workspace-trust.test.ts
bun packages/engine/scripts/test.ts test/hosted-autonomous-tool-prompts.test.ts
bun packages/engine/scripts/test.ts test/hosted-autonomous-sandbox-escalation.test.ts
```

The runner resolves its cwd from the engine package. Use it for focused runs too:
it owns the workspace lock, timeout and temporary-directory containment/cleanup.
Do not substitute direct Bun test execution. The old standalone `test:changed`,
`typecheck:test`, `build:all`, `smoke:boot`, `smoke:hosted`, `publish:check` and
`workflows:check` names are not daemon-product scripts here.

## What the test layers establish

- Unit and adapter suites test parser refusals, redaction, selected homes, config
  persistence, remote transports, service guards and send acceptance/failure.
- Composed-runtime suites build real owned service graphs over isolated homes.
  They exercise boot ordering, floor acquisition, cancellation, invalidation,
  late completion and awaited shutdown. A mocked provider is not a live account.
- Wire suites use [the daemon fixture](../src/testing/daemon-fixture.ts) and local
  HTTP/WebSocket/SSE fixtures to exercise authentication, native conversation
  intake/turns and scoped output. Use the actual route/handler path, not a mock's
  own return value as proof of integration.
- Autonomous-tool and workspace-trust suites use recorded synthetic Jev choices
  with real dispatch, PTY/local-server and action-admission boundaries. They can
  prove stale/copied permits or changing authority refuse. They do not establish
  live-model calibration, live Slack/email source authority or network delivery.
- Native verification consumes the produced artifact and its runtime/addons in
  a separate filesystem boundary. Building an OS target does not prove that target
  executes correctly on its native OS.

A report must name the exact command, source revision/diff, tested path, outcome,
failures/skips and environment. Distinguish a missing prerequisite from an assertion
failure. A passing focused run is not a full suite, aggregate CI or release receipt.
Tests should demonstrably fail when the behavior under test is broken.

For the optional inbox resolver API, persisted assignment and revocation
requirements, see [daemon inbox routing ownership](../../../docs/contracts/daemon-inbox-routing.md).
Its product factory tests complement the canonical engine store/resolver suites.

## Local native packaging

From `products/daemon`, after the root build:

```sh
bun run build:binary
bun run build:binary --target linux-x64
bun run build:binary --all
bun run smoke:binary --binary native/goodvibes-daemon-linux-x64
bun run verify:binary
```

Targets are `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`.
`smoke:binary` runs shared version/banner and emitted-artifact checks.
`verify:binary` uses ordinary Node, Linux and bubblewrap; it fails if isolation
or required artifact files are missing. It copies the configured host artifact,
its `lib/` native addon and adjacent Linux `.bun`, `.bun.json`, `.bun.LICENSE.md`
files into isolated homes and foreign cwd without the checkout/node_modules.
It checks the real executable; local scripted services remain synthetic fixtures.
The artifact set must stay together. These scripts are repository tooling,
excluded from the packed Bun script package, and publish nothing.
See [native packaging](cli-and-package-contracts.md#native-build-and-artifact-verification).

## Workspace CI and acceptance

The current [CI workflow](../../../.github/workflows/ci.yml) is the monorepo workflow,
not the former daemon repository's per-push job table. It includes the workspace
validation/build/test and evaluation lanes plus product/native artifact handling.
The product matrix runs `bun run products:test "$PRODUCT"`; its daemon leg builds
and records the Linux artifact, and the separate daemon native consumer verifies
that exact artifact before running `verify:binary`. Neither job is a publishing
policy or native macOS/ARM execution receipt.
Read that workflow and [root scripts](../../../package.json) for exact dependencies
and commands. `bun run validate` is an aggregate workspace gate; daemon-focused
checks do not replace it. `bun run products:check` validates executable workspace
structure. Source accounting and independent product acceptance are tracked in
[THE-18](https://linear.app/the-artificery/issue/TA-18/port-daemon-composition-and-remote-cluster-infrastructure); passing workspace checks does not close them.

Remaining deployment/qualification gates include configured standalone protected
screening bootstrap, a complete configured Discord inbox/DM catalog, product release
and update policy, final native cross-platform execution and live-provider/Jev
calibration. Real Jev wiring is not equivalent to live semantic qualification.

## Explicit local release preparation

From `products/daemon`:

```sh
bun run release:prepare --no-bump --no-changelog
```

That opt-in command synchronizes the product version fallback (and a version badge
if present); ordinary builds only validate consistency. Once version ownership is
chosen, the same tool accepts exactly one of `--patch`, `--minor`, `--major`, or
`--version X.Y.Z` instead of `--no-bump`. Changelog scaffolding requires a
product-owned `CHANGELOG.md` and explicit `--date YYYY-MM-DD` instead of
`--no-changelog`. It does not commit, tag, publish, deploy, choose an updater feed
or settle the separate root/product release policy. Inspect the diff in a clean,
exclusive checkout: ordinary write rollback is not a crash-safe concurrent transaction.
See [release preparation boundaries](cli-and-package-contracts.md#explicit-release-preparation).

These operator guides were reconstructed from pinned original responsibilities
and the current source. This page is a validation procedure, not a claim that lost
executor documentation bytes or historical validation receipts were recovered identically.

## Shared fixture and source-policy boundaries

See [test infrastructure and build preparation](test-infrastructure.md) for owned
cleanup, dependency-operation checks, strict preparation locks, workspace tool
resolution and structural workflow/architecture limits.
