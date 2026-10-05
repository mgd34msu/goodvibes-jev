# Release policy

This document describes the public release quality policy for the GoodVibes SDK
workspace. Historical release narratives live in `CHANGELOG.md`.

## Platform support

Release validation is supported on macOS and Linux. Windows users should use a
Linux CI runner or WSL2 for release validation because the validation scripts
use POSIX process management and filesystem behavior.

## Release rules

- Package versions must be aligned across the workspace.
- `CHANGELOG.md` must contain the release narrative for the package version.
- Generated contracts and generated docs must match source.
- Validation must pass before a release is cut.
- The automatic release path only fires once the `RELEASE_ARMED` repository
  variable is deliberately set to `true`; leaving it unset holds every green
  push on `main` without tagging or publishing.

The SDK targets Bun for daemon/platform surfaces and browser, Hermes, and
Workers for companion-safe surfaces. Node.js is not a documented consumer
runtime target; see [Runtime surfaces](./surfaces.md).

## By-reference release flow

A commit is validated exactly once, on its push-CI run, per-job green.
Everything downstream verifies *that run's* conclusions instead of re-executing
work. Two paths reach a published release: an automatic zero-touch path gated
on the repository variable `RELEASE_ARMED`, and a manual path for everything
else, including holding a release back or redoing a failed dispatch.

### Landing on `main`

Every push to `main` runs the full `ci.yml` gate set once: the consolidated
`validate` job, the eval gate, the security audit, the platform test matrix
(`bun`, React Native bundling, Workers, Workers with Wrangler), the
packaged-artifact conformance lane, and the packaging checks (`publint`, exports-map resolution). A single `build` job produces the
workspace `dist` output once and uploads it as the `workspace-build-output`
artifact; downstream package consumers restore those bytes. The self-contained
`validate` job still rebuilds and repeats some packaging checks; consolidating
those checks requires preserving each consumer and release requirement.

### Automatic path (`RELEASE_ARMED`)

An `auto-release` job runs after every gating job above succeeds, but only for
a push to `main`, and only when the `RELEASE_ARMED` repository variable is
`true`. Unset, or any other value, means CI finishes green without tagging or
publishing, which is how work can accumulate across several merges before
someone deliberately arms the next release.

When armed and green, the job reads the version out of the root
`package.json`, creates the annotated tag `v<version>` at that commit, and
pushes it. A tag pushed with the workflow's own token does not trigger
`release.yml`, since GitHub does not fire workflow events for token-authored
pushes, so the job also dispatches `release.yml` directly at that tag ref with
`mode=release`.

If the tag already exists, from a re-run of this job or a tag pushed by hand,
the job checks whether `release.yml` has ever run for it. A run in any state,
including a failed one, is left alone, since re-running a failed release is a
human decision. A tag with genuinely no run gets re-dispatched.

### Manual path

When `RELEASE_ARMED` is not set, or to redo a specific tag, cut and push the
tag by hand. Bump the workspace package versions, prepend the `CHANGELOG.md`
section, run `bun run sync:version` to refresh the generated version fallback,
commit, then run `bun run release:tag --push` (or tag locally and `git push
origin <tag>` separately). This step runs **no gates**; validation already
happened on the push-CI run for that commit. A pushed `v*` tag triggers
`release.yml` directly through its own tag-push trigger, the same workflow the
automatic path dispatches.

A `workflow_dispatch` run of `release.yml` with `mode=release` re-runs the
publish steps for an already-tagged commit, the redo path the automatic job
prints when it cannot resolve whether a release run exists. `mode=dry-run`,
the default for a manual dispatch, only packs and previews; it never
publishes and it is the only mode a manual dispatch outside `mode=release` can
run.

### What `release.yml` does, either way

1. `verify-tag-version` confirms the tag equals `packages/engine/sdk`'s version.
2. `release-verify` (the reusable `reusable-release-verify.yml`, run in
   `workspace` mode so the SDK verifies itself with its own toolchain rather
   than a published one) confirms the tagged commit's push-CI run concluded
   with **every job green**, using the toolchain `per-job-green` tool with a
   check-suites fallback. It reports the resolved run id and head SHA. This
   replaces the former 45-minute `validate-release` re-run.
3. `publish-npm` requires both jobs above to be green. It asserts the
   recorded head SHA equals the tagged SHA (the artifact-integrity handoff),
   then downloads the push-CI run's build artifact by that run id instead of
   rebuilding. It checks the registry state for this version, proceeding on
   empty, complete, or a resumable partial, and refuses only when an
   already-published package records a different commit than the one being
   released. It publishes with provenance from the `production` environment,
   polls propagation, and aligns the `latest` dist-tag across every published
   package with `scripts/align-dist-tags.ts`, needed because a plain `npm
   publish` moves `latest` to whatever it just published, which two
   overlapping releases can leave pointing backward.
4. `github-release` creates the GitHub release from the tagged
   `CHANGELOG.md` excerpt once npm publication succeeds.

Because tagging is gated on push-CI green either way, the tag-redo dance is
structurally retired. The SDK release wall drops from ~45-70m to ~15-20m,
dominated by the publish itself.

## Validation scope

Release validation covers:

- package build output
- TypeScript type checks
- unit and integration tests
- generated API reference docs
- generated contract artifacts
- changelog/version alignment
- bundle budgets

Contributors should run the focused check that matches their change before
opening a pull request. Maintainers run the full release gate before cutting a
release.

### README editorial readings

`bun run check:metadata` requires each package README to exist and contain
non-whitespace text, alongside the manifest, export, generated-type and runtime
version checks. External README editorial readings are advisory: missing or
stale evidence, negative answers and unsettled answers are printed with the
`package-readme editorial advisory` label without failing correctness CI.
An unreadable editorial cache is reported as unavailable, not as favorable.

Use `bun run package-readmes:read` for an intentional editorial review through
Jev (requires `TYPESAFE_API_KEY`), or add `--all` to read every README again.
The reader stores real evidence in
`packages/engine/etc/package-readme-readings.json`, keyed by the package name,
description and README content, with the battery version and model recorded.
Changing any of those inputs invalidates reuse; a green metadata check does
not imply fresh or favorable editorial evidence. No model request is made by
the metadata check, and other required documentation and runtime gates remain
in force.

## Release commands

Each release step has a dedicated script in the root `package.json`:

| Command | Purpose |
|---------|---------|
| `bun run release:dry-run` | Dry-run publish: runs `scripts/publish-packages.ts --dry-run` without publishing anything |
| `bun run release:publish` | Publishes all workspace packages to npm (`scripts/publish-packages.ts`) |
| `bun run release:publish:ci` | Publishes from CI with npm provenance attestations (`--provenance`) |
| `bun run release:tag` | Creates the git release tag (`scripts/create-release-tag.ts`) |
| `bun run release:verify` | Full local release gate: `validate`, `flags:graduation`, `security:audit`, the `test`/`test:rn`/`test:workers`/`test:workers:wrangler` suites, `release:dry-run`, and `install:smoke` |
| `bun run release:verify:published` | Verifies already-published packages and runs a registry install smoke check (`--registry`) |
| `bun run release:verify:verdaccio` | End-to-end publish/install dry-run against a local Verdaccio registry (`scripts/verdaccio-dry-run.ts`) |

Before opening a PR, run the focused check that matches the change rather than the full gate:

| Change type | Focused check |
|-------------|---------------|
| Public API / type surface | `bun run api:check` (and `bun run types:check`) |
| Contract schemas, method catalogs, or events | `bun run refresh:contracts` then `bun run contracts:check` |
| Generated reference docs | `bun run refresh:docs` (or `bun run docs:check`) |
| Error taxonomy (`SDKErrorKind`) | `bun run error:check` |
| Changelog / version bump | `bun run changelog:check` and `bun run version:check` |
| Entry-file gzip diagnostics | `bun run bundle:check` (references are advisory; imported dependencies are excluded) |
| Dependencies | `bun run security:audit`; preserve package license and notice metadata |
| Packaging / `exports` map | `bun run publint:check` and `bun run types:resolution-check` |

## Shared toolchain (`@goodvibes-jev/engine/toolchain`)

The release, publish, and verification scripts shared across the GoodVibes repos
live in one published workspace package, `@goodvibes-jev/engine/toolchain`. Each tool
is a policy function with injectable I/O plus a thin CLI (`bin`) entry. Repos
keep only their repo-specific values in a `toolchain.config.json` at the repo
root; the behavior lives in the package.

Twelve tools cover the release path from gate to publish.

| Tool | What it does |
| --- | --- |
| `sdk-pin-gate` | Verifies pin, lockfile, and installed SDK versions tri-agree, sweeps for non-npm imports, and optionally checks the exports map |
| `build-binaries` | Runs `bun build --compile` across a target matrix with optional daemon leg and native-addon handling |
| `release-cut` | Prepares, bumps, updates the changelog, and tags, without re-running gates; CI owns validation |
| `coverage-gate` | Aggregates coverage and enforces a per-repo floor that only increases |
| `verification-ledger` | Totals and renders a repo-collected verification inventory as JSON and Markdown |
| `post-build-smoke` | Boots a compiled binary and checks its version banner |
| `package-install-check` | Statically checks the `npm pack` tarball and bin-shim policy |
| `publish-package` | Publishes to npm idempotently and polls for propagation |
| `per-job-green` | Verifies a commit's push-CI run concluded with every job green; the by-reference validation check |
| `changelog-gate` | Asserts the changelog carries a section for the version being released |
| `sha256sums` | Generates or verifies a `SHA256SUMS` manifest over release assets |
| `train-status` | Read-only release-train report across the family's local checkouts, driven by its own `--manifest` flag rather than `toolchain.config.json` |

### `toolchain.config.json` contract

All sections are optional. A repo declares only the tools it uses. Import the
`ToolchainConfig` type from the package for editor help.

| Field | Purpose |
|-------|---------|
| `packageName` (required) | The repo's primary npm package name. |
| `sdkPin` | `{ sdkPackage, pinSource: "dependencies"｜"devDependencies", lockfile, overlayMarker, sourceRoots[], enforceExportsMap }`: parameterizes the SDK-pin tri-agreement. The agent bundles the SDK as a `devDependencies` pin; webui sets `enforceExportsMap: true`. |
| `build` | `{ appEntrypoint, daemonEntrypoint?, outDir, addonOutDir, targets[], prebuild[][] }`. A target carries `{ key, bunTarget, appArtifact, daemonArtifact?, nativeAddonPackage?, nativeAddonFile?, capturedBunRuntime? }`. Presence of `daemonEntrypoint` + a target's `daemonArtifact` builds the daemon leg. |
| `coverage` | `{ funcsFloor, linesFloor, command[] }`: the aggregate coverage floor that only rises. |
| `smoke` | `{ bannerPrefix, forbiddenStrings[], binaryDefault }`: post-build binary smoke. |
| `releaseCut` | `{ branch, versionFiles[], syncCommands[][], commitPaths[], changelogHeading: "bracket"｜"plain", changelogInsertMarker: "first-separator"｜"top" }`. |
| `publish` | `{ packageName, defaultRegistry, requiredTarballPaths[], forbiddenTarballPrefixes[], maxTarballBytes }`. |
| `perJobGreen` | `{ owner, repo, workflow, event, pollIntervalMs, deadlineMs }` (the CLI also accepts `--repo/--sha/--workflow` and `GITHUB_REPOSITORY`/`GITHUB_SHA`). |

### Compiled Linux captured-REPL runtime bundle

The private Jev Agent and TUI Linux x64/arm64 target rows declare
`capturedBunRuntime: "1.3.14"`. A successful `build-binaries` result includes,
for each compiled app (and configured daemon leg):

- `<artifact>`: the compiled product
- `<artifact>.bun`: a separate ordinary Bun interpreter, executable mode 0755
- `<artifact>.bun.LICENSE.md`: the pinned upstream mixed-license notice,
  source location, and JavaScriptCore/WebKit relinking instructions
- `<artifact>.bun.json`: version, target, source, and runtime SHA-256 provenance

The compiler's native ordinary Bun can supply the runtime when its version and
ELF architecture match. It must evaluate a real `--print` probe from an empty
working directory with a minimal environment. Otherwise the build resolves the
explicit official target package, or fetches the exact reviewed 1.3.14 package
from the npm registry with package scripts disabled. The only admitted package
sources are `@oven/bun-linux-x64-baseline` and `@oven/bun-linux-aarch64`; archive
SHA-512, payload SHA-256, package name/version/platform, regular-file archive
entries, package boundaries, and ELF machine type are checked before staging.
The compile target and requested runtime target must agree. A staging failure
makes the entire target unsuccessful. Runtime launch never searches PATH or
fetches a replacement.

Move the executable and its three companions together. If the executable is
renamed, apply the same rename prefix to all companions: the runtime is resolved
as `${process.execPath}.bun`. The current monorepo Agent/TUI CI archives and
provenance manifests include and verify all companions. The private TUI launcher
runs the dist artifact without renaming it; the Agent source launcher runs under
the caller's ordinary Bun. macOS and Windows target rows deliberately do not
advertise captured-REPL support and do not stage this Linux-only runtime.

This change covers the private workspace build and current monorepo CI artifact
transport. Legacy separately published product installers, updaters, platform
npm packages, and release workflows are not a supported sidecar distribution
path; their executable-only copy/download/rename operations must be migrated
before making that release claim. No release or deployment is performed by
this packaging change.

Bun's own code is MIT-licensed, but the ordinary binary statically links
JavaScriptCore/WebKit under LGPL and includes additional libraries under other
licenses. The npm package's `license: "MIT"` metadata does not describe the
whole binary. The retained upstream notice is from
[Bun 1.3.14](https://github.com/oven-sh/bun/blob/bun-v1.3.14/LICENSE.md), with
[matching Bun source](https://github.com/oven-sh/bun/tree/bun-v1.3.14) and its
[patched WebKit source](https://github.com/oven-sh/webkit). Before a public binary
release, verify and supply the corresponding source/object/relink materials and
all required third-party license texts for the exact distributed binaries.
Copying this notice alone does not close those redistribution obligations.

### Reusable workflows

Hosted in this repo's `.github/workflows` and consumed cross-repo via
`uses: mgd34msu/goodvibes-sdk/.github/workflows/<name>.yml@main`:

- `reusable-release-verify.yml`: by-reference per-job-green, emits `run_id` +
  `head_sha`.
- `reusable-npm-publish.yml`: provenance + propagation poll.
- `reusable-gh-release.yml`: release body from an optional `notes-file`
  override, `{version}` expands to the un-prefixed tag; when the file exists
  at the checked-out ref its prose is the body, e.g. the TUI's
  `docs/releases/<version>.md`, otherwise the CHANGELOG excerpt, plus
  `SHA256SUMS`.
- `reusable-binary-matrix.yml`: build-binaries + per-leg post-build-smoke:
  each smoke leg declares its own `binary` in the targets JSON, since matrix
  legs only build their own suffixed artifact. `smoke.binaryDefault` serves
  local CLI runs only.

The glob inputs (`assets-glob`, `artifact-glob`) accept spaces or newlines as
separators; the workflows normalize them to the newline-separated form their
sinks require. The composite `./.github/actions/setup` action is the single
Bun setup (one `bun-version` source, frozen-lockfile + cache always on).

## Changelog

Every release has a matching `CHANGELOG.md` section:

```md
## [X.Y.Z] - YYYY-MM-DD

### Breaking
### Added
### Changed
### Deprecated
### Removed
### Fixed
### Security
### Migration
```

This block is illustrative, not a closed list. The full [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
section set (`### Added`, `### Changed`, `### Deprecated`, `### Removed`, `### Fixed`, `### Security`) is
permitted, plus the project-specific `### Breaking` and `### Migration` sections. Only include sections that
apply. The changelog is the canonical release narrative for users and downstream maintainers.

## Generated references

The generated docs are:

- `docs/reference-operator.md`
- `docs/reference-peer.md`
- `docs/reference-runtime-events.md`

These files are derived from source contracts and must not be edited by hand
except as part of the documented generation workflow.

## Contract artifacts

The SDK package embeds generated contract JSON artifacts for public contract
subpaths. Contract artifacts must be refreshed when method catalogs, schemas,
events, or generated client types change.

## Failure handling

If a release gate fails:

1. Fix the source of truth.
2. Regenerate derived files when needed.
3. Rerun the focused failing check.
4. Rerun the release gate before cutting a release.

Common release-gate failures and their fixes:

- **Contract drift.** `contracts:check` fails when SDK-embedded contract JSON diverges from `packages/engine/contracts/artifacts`. Run `bun run refresh:contracts`, then re-validate.
- **Missing built export.** `bundle:check` fails when a declared JavaScript entry file is absent. Fix the package output. Historical size-reference advisories do not block release validation or require an invented threshold.
- **Types resolution (attw).** `types:resolution-check` fails when the `exports` map does not resolve cleanly for a published subpath. Fix the `exports`/types wiring in `packages/engine/package.json`.
