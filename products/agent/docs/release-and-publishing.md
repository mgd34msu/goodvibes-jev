# Release and publishing

GoodVibes Agent's current installable version is recorded in `package.json` and `CHANGELOG.md`.

## Package identity

- registry package: `@pellux/goodvibes-agent`
- executable: `goodvibes-agent`
- connected-host compatibility: checked through public Agent routes. `AGENT_DAEMON_BUILD_FLOOR` (`src/runtime/daemon-build-compatibility.ts`) is `1.28.0`, the daemon build where the daemon/TUI product split landed. A daemon older than that build is refused at adoption, meaning the memory spine stays local, the inbound dispatch never binds, and the operator gets a one-time "update the daemon" notice naming both versions. Raises to this floor are recorded in `CHANGELOG.md` and the release notes.
- runtime: Bun `1.3.14` or newer
- source language: TypeScript
- package docs: every Markdown file under `docs/*.md`
- connected host ownership: outside Agent
- current release line: stable patch releases

End users install and run GoodVibes Agent with Bun:

```sh
bun add -g @pellux/goodvibes-agent
goodvibes-agent --help
```

Do not add non-Bun install instructions for this product. The package is hosted on the public package registry, but the supported install and smoke path is the normal Bun global command above, followed by `goodvibes-agent` launching the TUI. The package-facing text check at the version bump rejects non-Bun Agent install/run snippets and references to other GoodVibes packages.

## Release gates

What runs on every push, before a release, and at the version bump is described in [testing-and-validation.md](testing-and-validation.md). In short: push CI runs the typecheck, the architecture check, the test suite once, the linux-x64 build with its banner smoke, the end-to-end smoke on that build, and the package gate; a push whose version has no tag yet also runs the release end-to-end set before it is tagged.

The package gate (`bun run publish:check` and `bun run package:install-check`) is what a publish depends on:

- the platform runtime pin, the installed copy and the lockfile agree, and no local development overlay is present
- `package.json` keeps the public name, `private: false`, the module entry `dist/package/main.js`, public access, the `goodvibes-agent` bin at `bin/goodvibes-agent.ts` (present, executable, Bun shebang, loading the bundled runtime), the `files` manifest with its required entries and exclusions, and an exact version
- the npm tarball holds every required path, including the bundled runtime and the release evidence bundle, and none of the forbidden ones (tests, verification source, workflows, local state), within the size cap
- the packed tarball installs with `bun add -g` into an empty home; the installed command answers `--help`, `--version` and `status --json`, refuses the retired lifecycle commands with guidance on stderr, launches the TUI in a PTY without exiting, and never prints a seeded connected-host token

The release-quality inventory, `release/release-readiness.json`, the performance snapshot, the release notes and the live-verification report travel in the package: the packaged Agent exposes them through `agent_harness` modes `release_evidence`, `release_evidence_artifact`, `release_readiness` and `release_readiness_item`, so the model can inspect the same operator/audit artifacts without relying on hidden project context. Use neutral evidence aliases in release evidence. They are regenerated at the version bump (`bun run release:prepare`); the live-verification report is refreshed there against the built binary and the connected host, not checked for age on every push.

At the bump, release:prepare also checks the text a reader sees on the package page and in the installed docs: README, CHANGELOG and the shipped `docs/*.md` pages name no GoodVibes package but this one (the runtime it bundles is "the bundled GoodVibes platform runtime"), give Bun install instructions only, and carry none of the retired default-knowledge routes or TUI-only commands.

`bun run publish:package` publishes from a staged package directory to the package registry. It re-runs the package checks against the source tree, filters forbidden package paths during staging, and verifies the staged package docs, required package paths, and metadata before invoking npm. If `NPM_CONFIG_USERCONFIG` is already set, the registry publish command uses it. Otherwise the script creates a temporary 0600 registry userconfig from `NODE_AUTH_TOKEN` or `NPM_TOKEN`, uses it for that publish command, and removes it with the staging directory. It is idempotent for reruns: if the exact package version is already on the registry, it reports that and exits successfully.

`bun run release` requires product release notes instead of raw git-log output. Pass `--notes-file ./release-notes.md` or set `GOODVIBES_AGENT_RELEASE_NOTES` before a real release. For patch releases, use product-facing notes that summarize the complete patch contents, not only the first fix in the batch. Do not use commit hashes as the shipped changelog content.

Before it mutates version metadata or creates a tag, `bun run release` requires a clean worktree on `main` (pre-generated release evidence is allowed and staged), then checks the declared files under `release/` for existence, non-empty content, final newlines, trailing whitespace, and space-before-tab indentation. It bumps the version, regenerates the stamps and pins through `scripts/release-prepare.ts --no-bump --no-changelog`, prepends the CHANGELOG section, and checks the package.json shape, the package-facing text and that `package.json`, `CHANGELOG.md`, `src/version.ts` and the release notes stamp agree before it commits and tags. The release cut does not re-run the test suite: validation runs once, on the release commit's push-CI run, and the release workflow verifies by reference that every job of that run passed for the exact tagged SHA.

`--skip-validation` is only allowed with `--dry-run`. `--dry-run` is non-mutating and may be used from a dirty or non-main worktree to preview the next version and generated changelog section. For patch previews, use `bun run scripts/release.ts --dry-run --patch --notes-file ./release-notes.md`.

The GitHub release workflow publishes to npm only when the repository variable `PUBLISH_NPM` is `true` and the repository secret `NPM_TOKEN` is configured. Without those repository settings, the workflow still builds and creates the GitHub release, but npm publish must be run from a local environment with an exported token. After npm publish, the workflow installs the exact registry version into an isolated Bun home, seeds a connected-host token sentinel, captures stdout and stderr for `--version`, `--help`, and `status --json`, and fails without printing that sentinel.

On a cross-target build the runner does not have the target platform's optional sqlite-vec package installed, so the build fetches that platform's addon from the npm registry (pinned to the resolved `sqlite-vec` version) and copies it into `dist/lib/sqlite-vec-<os>-<arch>/`; a failed fetch or a missing addon in the fetched package is a hard build failure, never a silent skip.

### sqlite-vec native addon release assets

A compiled Agent binary loads the sqlite-vec native addon from `<binary-dir>/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>` (`vec0.so` on Linux, `vec0.dylib` on macOS). Bun cannot embed a native addon inside the compiled binary, so the release lane ships the addon as a separate per-platform asset.

Each build matrix leg contributes its target's addon tree, and the GitHub Release job packages one archive per platform, `sqlite-vec-<os>-<arch>.tar.gz`, whose interior layout is exactly `lib/sqlite-vec-<os>-<arch>/vec0.<suffix>`, so it extracts in place next to the binary with no renaming. All four archives are checksummed in `SHA256SUMS.txt` alongside the binaries under the missing-entry-fatal convention. A directly-downloaded binary can restore the semantic vector index by co-locating the matching addon, as described in the README's install section.

On macOS the system SQLite that `bun:sqlite` links refuses to load extensions, so the darwin archives ship for parity but the vector index stays unavailable there and memory search degrades to literal matching; this is a platform capability limit, not a packaging defect.

## Do not ship

Do not publish if package-facing docs or install commands refer to another package name, another executable, or Agent-owned connected-host lifecycle.

Do not publish if `README.md` or `docs/README.md` omits a package-facing docs page, or links a docs page that is not included by the package `files` manifest.

Do not publish if Agent Knowledge commands can fall back to default knowledge or another product-specific knowledge route. Agent Knowledge must use the isolated `/api/goodvibes-agent/knowledge/*` segment.

Do not ship connected-host binaries from this package. If Agent later gets compiled artifacts, they must use Agent artifact names and remain separate from connected-host ownership.

## Product rule

Stable patch releases can include mature terminal foundation code, but package-facing behavior must follow Agent product policy. Follow-up patch releases should continue pruning or reshaping coding-first surfaces while preserving the renderer, input, fullscreen workspace, command registry, and release foundation.
