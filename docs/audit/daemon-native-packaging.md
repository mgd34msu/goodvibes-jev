# Local daemon native packaging

THE-18 remains **In Progress**. The private daemon can now opt into compiling
its actual `products/daemon/src/cli/entrypoint.ts`; ordinary `build` and `test`
remain the TypeScript script-package workflows. This increment does not add a
default inbox, a fixture executable, an injected module loader, a release job,
or a published native artifact.

## Build contract

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

`scripts/check-version.ts` only validates this product's manifest identity and
the exact baked fallback in `src/version.ts`. Root `sync:version` owns only the
engine fallback. Until daemon release ownership is implemented, an intentional
daemon version change must update its manifest and fallback together. This
check performs no write, bump, changelog update or release preparation.

## Artifact verification

`build:binary` compiles the host target. `smoke:binary --binary <path>` invokes
the installed engine's real post-build smoke, including its emitted namespace
scan. `verify:binary [--binary <host artifact>]` consumes an already-built native
artifact with ordinary Node and requires Linux plus working bubblewrap.

The verifier copies the actual binary, native addon, ordinary Bun runtime and
runtime notice/provenance into an owned temporary tree outside the checkout.
Its child filesystem contains only OS libraries and that tree, with a foreign
working-directory `package.json`, isolated HOME/state-tree/daemon homes, a fixed
environment and no workspace source or `node_modules`. Missing isolation or any
required asset fails; no case silently skips. It runs the shared smoke against
the copied binary and then checks:

- Exact daemon manifest version despite the foreign manifest; root and sessions help.
- Unknown commands/flags and misplaced first-word commands exit 2.
- Bare/explicit serve and service install/start/restart/migrate refuse before
  daemon configuration, token or service files appear.
- Actual `config set/get` persists only in the selected relative daemon home.
- Actual compiled `send` accepts argv and multiline stdin and reaches an owned
  synthetic loopback ntfy server with exact body, title, destination and synthetic
  credential. The server occupies the configured daemon port, and competing
  default settings cannot override the selected home. No real provider is used.
- Send keeps the selected settings/secrets unchanged and creates no operator
  token, lifecycle/receipt or detached daemon state.

The focused wrapper/version tests run with the ordinary daemon suite. Existing
shared toolchain tests own target resolution, required-addon failure, sidecar
verification and post-build smoke internals. A separate negative probe invokes
the actual shared build CLI with a missing entrypoint and requires its compiler
failure to propagate as exit 1. Native verification
is opt-in; it does not compile all platforms on every ordinary test invocation.
Only the Linux host artifact is exercised by this proof. The other three target
rows retain their configured contract but have not been built or run here.

## Pinned source accounting and limits

Original source: `mgd34msu/goodvibes-daemon` at
`254699bf5d834cdca41436211ada1ae32bf89258`. The reviewed
`toolchain.config.json` delta is
`6016baa7f56e90f8f35d9b158586c4a52ed03e8e` →
`d39c1a0d263a738019d45c96b8d7188a298ecae9`.

| Section | Current disposition |
| --- | --- |
| Workspace identity / sdkPin | Adapted to private `@goodvibes-jev/daemon`, installed `@goodvibes-jev/engine`, dependencies and `../../bun.lock`; no standalone npm pin claim. |
| Build / smoke | Adapted to the real current CLI, shared compile driver, separate native output and pinned Linux runtime; original four artifact/addon names and smoke sentinels retained. |
| Coverage removal | Existing monorepo policy already has no percentage quota; none is introduced. |
| releaseCut | Omitted. Upstream changed sync from prebuild to `release-prepare.ts --no-bump --no-changelog` and changelog placement from first-separator to top. Neither is implemented by the validation-only version helper. This delta remains deferred. |
| publish | Omitted. The package remains private; root monorepo package checks own script-package artifacts. No legacy standalone registry/publish lane is enabled. |
| perJobGreen | Omitted. Main/PR qualification remains the current monorepo CI policy; no legacy daemon repository polling is configured. |

The reconciliation JSON therefore retains the toolchain row as **deferred**, with
its local build/smoke sub-scope recorded separately. The four other outstanding
upstream rows remain deferred: `.github/workflows/release.yml`,
`scripts/hosted-session-proof.ts`, `scripts/release-prepare.ts`, and
`src/test/scripts/release-prepare.test.ts`. Hosted proof still lacks default inbox
composition and explicit Jev setup. The explicit-host provider-preload increment
now restores persisted-provider boot registration; see `daemon-provider-preload.md`
for its source-level HTTP and ownership proof. Complete compiled-hosting acceptance
remains pending. Local artifact success does not satisfy the remaining
runtime/release contracts.
