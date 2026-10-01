# Testing and validation

## What runs where

| When | What | Command |
|------|------|---------|
| While you work | the test files your change affects, the files you touched, and a typecheck | `bun run test:changed`, `bun test <file>`, `bun run typecheck:test` |
| Every push to `main` and every PR (`ci.yml`) | typecheck, import-cycle and layer check, workflow structure, the full test run, the linux-x64 build and banner smoke, the end-to-end smoke (main screen and first turn) on that build, the SDK-pin, package.json and tarball checks, and a `bun add -g` install of the packed tarball | CI |
| Before a push that releases, nightly, on demand (`release-gates.yml`) | the release end-to-end set: daemon drop and re-adoption | CI |
| Version bump | version stamps, the Google setup runbook, workflow pins, the CHANGELOG section, the release notes stamp, the live-verification report | `bun run release:prepare` |
| Release (`release.yml`) | verifies the tagged commit's push CI was green job by job, then builds, smokes and publishes | CI |

Local work never needs the whole suite. CI runs it on every push, once.

## Local commands

```bash
bun run test:changed                        # test files affected by changes since origin/main
bun test src/test/input/settings-modal.test.ts   # one file
bun run test settings-modal                 # the runner, filtered by a path fragment
bun run typecheck:test                      # src/ (tests included), scripts/ and bin/
bun run architecture:check                  # import cycles and layer boundaries

bun run build                               # the binary the end-to-end tests drive
bun run test:e2e:fast                       # main screen, first turn, first-start question
bun run test:e2e                            # every end-to-end scenario
```

`test:changed` is `bun run scripts/run-tests.ts --changed=origin/main`: the
runner hands its file set to Bun's own `--changed` selection, which runs only
the files whose import graph touches something changed since `origin/main`
(committed or not). Pass another base with
`bun run scripts/run-tests.ts --changed=<ref>`, or a bare `--changed` for
Bun's default base. `--changed` and a positional path filter combine.

`bun run test` runs every file under `src/` except `src/test/e2e`. It is what
the CI `test` job runs; you rarely need it locally.

## Test layers

- **Unit.** One Agent module called directly with real inputs: a renderer, a
  command handler, an input route, a tool, a store. Fakes stand in only for
  what is outside the unit: a provider, a clock, the network, a host tool.
- **Composed runtime.** The Agent's own composition
  (`src/runtime/services.ts`) over a temp home
  (`src/test/helpers/runtime-services.ts`), for what that composition wires:
  which handlers exist, which stores are real, what a command or tool call
  reaches, what the permission layer refuses.
- **Golden frames.** `src/test/renderer/golden-frames*.test.ts` render a
  surface at fixed widths and compare it byte for byte with the committed frame
  under `src/test/renderer/golden-frames*/`. Frames pin a fixture version
  (`0.0.0-golden`), never the live one, so a version bump changes no frame. A
  deliberate visual change updates the frame in the same commit
  (`GOODVIBES_UPDATE_GOLDENS=1 bun test <file>`).
- **End to end.** `src/test/e2e/` drives the COMPILED binary in a real terminal
  (a tmux server the harness owns) with an isolated home, a scratch git
  workspace, launch self-update off, the daemon port pinned to an unused one,
  and a scripted OpenAI-compatible model served from the test process
  (`src/test/e2e/harness.ts`). It reads the rendered screen, what the binary
  wrote to stderr, and, for the daemon scenario, every call the binary made to
  the daemon's port.

| Scenario | File | Runs |
|----------|------|------|
| startup draws the main screen (header with this build and the model, splash, input area, status line with the model's context window) and a typed prompt is answered on it | `startup-first-turn.e2e.test.ts` | every push |
| first start in a new workspace: the register-this-workspace question is drawn as a modal, and after it is answered the first typed prompt reaches the model whole and the decline is recorded | `first-start-workspace.e2e.test.ts` | every push |
| the Agent adopts a running daemon, notices it go, and adopts the new one that comes back on the same port | `daemon-readoption.e2e.test.ts` | release gates |

Each scenario was checked against a broken build: breaking the behavior in
source, rebuilding and running the test made it fail, and restoring the file
made it pass again. The daemon scenario boots its own daemon on an ephemeral
port inside the isolated home; nothing in the suite touches the real home
directory, a daemon the machine is running, or its service units.

A test earns its place by failing when behavior breaks. Tests that read
source, docs or workflow files as text, pin wording or constants nothing
parses, assert a mock's own return value, render twice and compare, or only
check that something is defined do not; neither do tests of the bundled
GoodVibes platform runtime's own code, which belong with that runtime. They
were removed in the 2026-09 overhaul and should not come back. Before adding a
test, break the behavior it covers and watch it fail.

## Per-push CI (`ci.yml`)

| Job | Command | Purpose |
|-----|---------|---------|
| `typecheck` | `bun run typecheck:test`, `bun run architecture:check`, `bun run workflows:check` | tsc over everything; no new runtime import cycles and no forbidden layer edges; every workflow parses and no job hides behind `continue-on-error` |
| `test` | `bun run test` | The suite, once |
| `build` | `bun run build:linux-x64`, `scripts/post-build-smoke.ts` | The binary and the toolchain banner smoke; uploaded for `e2e-smoke` and the release gates |
| `e2e-smoke` | `bun run test:e2e:fast` | The main screen, a first turn, and the first-start workspace question on the built binary |
| `package-gate` | `bun run publish:check`, `bun run package:install-check` | SDK pin, installed version and lockfile agree; package.json has the shape a publish needs; the npm tarball holds the files an install needs and none it must not; the packed tarball installs with `bun add -g` and the installed command runs and launches |
| `release-intent` | `git ls-remote` | Pushes to `main` only: does this version still need a tag? |
| `release-gates` | `release-gates.yml` | Only when `release-intent` says the push releases |
| `auto-release` | tag + dispatch | Only when the push releases, after every job above; tags the version and dispatches `release.yml` |

`architecture:check` lists the two runtime import cycles present when it was
introduced; a new cycle fails, and so does a listed one that is gone, so the
list only shrinks.

## Release gates (`release-gates.yml`)

| Job | Command | Purpose |
|-----|---------|---------|
| `e2e` | `bun run test:e2e:release` | Daemon drop and re-adoption on the built binary |

## Version bump: `bun run release:prepare`

Everything that carries the version, or is generated from something else, is
written at the bump and never checked per push:

```bash
bun run release:prepare --minor         # or --patch, --major, --version X.Y.Z
bun run release:prepare --no-bump       # regenerate at the current version
```

It sets `package.json`'s version, relocks (`bun install`), writes the
`src/version.ts` fallback, the README badge and the `docs/README.md` release
line (`scripts/prebuild.ts`), regenerates `docs/google-setup-runbook.md`,
points every reusable-workflow reference in `.github/workflows` at the commit
the pinned platform version's tag names and every toolchain spec at the pinned
toolchain version, scaffolds the CHANGELOG section and a
`release/release-notes.md` stamped for the new version, builds the binary and
refreshes `release/live-verification/` with the live verifier in strict mode
against it and the connected host. It ends by checking that the README,
CHANGELOG and shipped docs name no GoodVibes package but this one and that
every version stamp agrees. It never commits or tags.

`npm version` runs it through the `version` script (without the live report),
and the release cut (`bun run release`) runs it as its sync command with
`--no-bump --no-changelog`, since the release cut writes those itself.
`--no-install`, `--no-pins` and `--no-live` skip the steps that need the
network or a running connected host.
