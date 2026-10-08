# Testing and validation

> Consumer and contributor guidance. For internal testing architecture see [Testing Architecture](./testing.md).

The SDK repo validates more than TypeScript build success. `bun run validate` is the portable command CI runs; it does not require any external repo checkout.

## Run the repo's declared script, never a guessed runner

**Always invoke a repository's own `package.json` script, `bun run test`, and
never a runner you inferred from the file layout.** Getting this wrong produces
a false regression report against work that is fine, which costs a whole round
chasing nothing.

A worked example from this repo's consumers. Running the webui's suite three
ways, on an identical clean tree:

| Invocation | Result |
|---|---|
| `bunx vitest run` | **159 files failed**, "no tests" |
| `bun test` (bare) | **157 fail, 141 errors** |
| `bun run test` (the declared script, `bun test --isolate`) | **2168 pass, 0 fail** |

The first two are artifacts of the wrong runner, not defects. `vitest` cannot
resolve `bun:test` imports at all, so every file fails at import. Bare `bun test`
skips the `--isolate` flag the suite requires and collapses with
`Cannot call beforeEach() after the test run has completed`, a symptom that
looks like a real async bug and is not.

Either number, reported as a regression, would have been a false alarm against
solid work. The declared script exists because it encodes the flags the suite
needs; treat any disagreement between your invocation and the script as your bug
until proven otherwise.

The same rule covers `typecheck`, `lint` and `build`: a repo that ships a script
has already made these decisions, and a hand-built command silently opts out of
them.

## CI gates

This is the canonical CI-gate reference for the workspace. Every push and PR to `main` runs the required jobs in `.github/workflows/ci.yml`; `auto-release` runs only after all of its validation dependencies are green, only on a push to `main`, and only when the repository variable `RELEASE_ARMED` is set to `true`. The contract-artifact, version, error, examples, API-surface, and bundle-budget checks run as ordered steps inside `validate` (see `scripts/validate.ts`). Documentation sync/completeness, changelog headings and TODO-marker wording remain opt-in editorial commands; they do not gate functional changes. Release tooling still validates the release changelog when cutting a release.

| Job | Command | Purpose |
|------|---------|---------|
| `validate` | `bun run validate` | Kitchen-sink validation. Runs these checks as ordered steps: error/credential-scope/judgment-lint/version/internal-id/architecture/platform-console gates, TypeScript build, the full typecheck gate (`typecheck`, both the composite project solution and the standalone type-test project), API-surface check (`api:check`), exports-coverage check (`exports:check`), examples typecheck, browser-compat, package metadata, no-any, pack, publint, install smoke, contract-artifact check (`contracts:check`), and entry-file gzip diagnostics (`bundle:check`) |
| `eval-gate` | `bun run eval:baseline:check` then `bun run eval:gate` | Runs the standing eval suite through the production eval paths against the restored build artifact. Checks the checked-in baseline for drift first, then fails on any absolute-floor failure or regression against that baseline |
| `security-audit` | `bun audit --audit-level high` + gitleaks scan (`gitleaks/gitleaks-action`) | Runs `bun audit --audit-level high` against the workspace dependency tree and a gitleaks secret scan; the CI job invokes these two steps directly (local `bun run security:audit` covers only the dependency-audit half) |
| `build` | `bun packages/engine/scripts/build.ts`, then the Agent native build | Builds shared engine/judgment output and the Agent E2E binary for the `workspace-build-output` artifact. Product builds run in `validate`, without repeating them here |
| `platform-matrix` | `bun packages/engine/scripts/test.ts --partition=INDEX/COUNT` (Bun legs), judgment and fake-IMAP sweep once, plus `bun run test:rn`, `bun run test:workers`, `bun run test:workers:wrangler` | Restores the shared `build` artifact without rebuilding. The build-generated matrix covers the complete default engine manifest in four disjoint Bun partitions, plus the three companion runtime legs |
| `types-resolution-check` | `bun run types:resolution-check` (attw over the release stage of the engine and judgment packages, ignoring `no-resolution` and `cjs-resolves-to-esm`) | Validates the `exports` map resolves cleanly for every published subpath |
| `publint-check` | Aggregate of `validate` | Retains the required-check name and fails on failed, cancelled or skipped validation. The real `bun run publint:check` executes once inside `validate` |
| `artifact-lane` | `bun run release:artifact-lane` | Packs every workspace package exactly as publish would, installs the tarballs into a scratch consumer, and runs the shipped conformance kit against a catalog/daemon composed from those packed artifacts, proving the tarballs are internally coherent before publish |

The `platform-matrix` job has four Bun partitions and three companion runtime legs:

- **bun 1/4, bun 2/4, bun 3/4, bun 4/4.** Each runs one disjoint partition of the complete default engine test manifest through the existing owned runner. The first leg also runs `bun run test:judgment` and `bun run sweep:wake-race` once. Every leg is required; `fail-fast: false` lets the others finish after a failure. The `platform-matrix` dependency includes all seven legs. A lightweight aggregate retains the existing `Platform matrix (bun)` check name and fails if any leg failed, was cancelled, or was skipped.
- **rn-bundle.** `bun run test:rn` verifies companion dist bundles, including `workers.js`, contain no `Bun.*` identifiers and no `node:*` imports.
- **workers.** `bun run test:workers` runs the `./web` entry under Miniflare 4 (workerd V8 isolate, in-process). 9 tests validate Worker-runtime support (no `node:*`, no `Bun.*`, no client `EventSource`/`WebSocket` dependence). The dedicated `./workers` bridge is covered by source-level batch bridge tests and the `rn-bundle` companion scan.
- **workers-wrangler.** `bun run test:workers:wrangler` runs the `./web` entry under `wrangler dev --local`. Exercises wrangler's esbuild bundling pipeline and wrangler.toml config. NOTE: wrangler dev --local shares the Miniflare 4 runtime, so this is **not** a production-workerd verification. See `test/workers/NOTES.md` for runtime coverage boundaries.

## Engine partition discovery and reproduction

`test-discovery.ts` is the single file-selection source for both the ordinary
local run and CI. It discovers every matching nested test file in stable order,
excluding only the existing separate runtime areas (`workers`,
`workers-wrangler`, `hermes`), fixture/type inputs, and generated/dependency
folders. The partitioner sorts that manifest and distributes files round-robin.
It never changes test bodies, skips, per-test deadlines, or network/credential
isolation. Each partition owns one sequential Bun child, one contained temp
root, and the existing stall/overall watchdogs for its whole lifetime. Tests
within a file stay together. CI adds process isolation between partitions;
it does not add per-file isolation or concurrent tests within a child.

The build job emits the complete matrix and uploads `engine-test-manifest`,
which lists every file and partition with a SHA-256 of the sorted file list.
Each CI leg recomputes discovery and rejects a different manifest hash before
starting tests. New test files enter automatically. Empty partitions, duplicate
files, invalid indices, and combining a partition with file/name filters or
`--cwd` are errors. The regression gate compares the real matrix's disjoint
union against both canonical discovery and an independent filesystem inventory.

To inspect or reproduce a partition after building the workspace:

```bash
bun packages/engine/scripts/test-partitions.ts manifest
bun packages/engine/scripts/test-partitions.ts matrix
GOODVIBES_TEST_CEILING_MS=900000 bun packages/engine/scripts/test.ts --partition=1/4
```

The CI legs retain their existing 900-second total runner ceiling, 180-second
stall watchdog, 60-second default per-test ceiling and 20-minute job cap.
Partitioning adds capacity rather than extending or restarting those deadlines.
The default local `bun run test` remains sequential with its existing lifecycle
and budgets; no-argument `scripts/test.ts` still selects the full engine suite
in one child, and explicit file selections retain their existing behavior.

## Portable validation

```bash
bun run validate
```

`bun run validate` runs the same complete ordered step list documented in the
`validate` row of the [CI Gates](#ci-gates) table above, from API docs sync
and docs/examples completeness through the error/credential-scope/
changelog/version/todo/internal-id/architecture/platform-console
gates, the TypeScript build, the full typecheck gate, the API-surface and
exports-coverage checks, examples typecheck, browser-compat, package
metadata, no-any, pack, publint, install smoke, the contract-artifact check,
and bundle budget.
Test execution is owned by the `platform-matrix` jobs; run `bun run test` locally when
you need the full Bun test suite.

`bun run build` and the package test scripts share the repo workspace lock.
That prevents tests from reading `packages/*/dist` while another build or
validation process is cleaning and rebuilding package output. Use
`bun run test`, `bun run test:rn`, `bun run test:workers`, or
`bun run test:workers:wrangler` instead of invoking `bun test ...` directly
when package `dist` imports are involved.

## Focused checks

For fast iteration, run the individual check that matches your change instead of
the full `validate` job:

| Command | Purpose |
|---------|---------|
| `bun run validate:strict` | Runs `validate`, then `types:check` and `contracts:check` for an extra-strict local pass |
| `bun run dist:check` | Checks that committed `dist/` output is fresh relative to source (`scripts/check-dist-freshness.ts`) |
| `bun run check:browser` | Browser/companion compatibility scan (`scripts/browser-compat-check.ts`) |
| `bun run check:metadata` | Validates published `package.json` metadata (`scripts/package-metadata-check.ts`) |
| `bun run any:check` | Fails on disallowed `any` types (`scripts/no-any-types.ts`) |
| `bun run platform-console:check` | Fails on disallowed platform `console.*` usage (`scripts/no-platform-console.ts`) |
| `bun run security:audit` | Dependency audit at `--audit-level high` (`bun audit`) |

## Contract refresh

When generated contract artifacts change, refresh the canonical contract package artifacts before validating:

```bash
bun run refresh:contracts
bun run validate
```

`bun run refresh:contracts` updates generated contract JSON artifacts in `packages/engine/contracts/artifacts`. SDK package preparation copies those artifacts into the published package. source copies were removed; sibling packages are the source of truth.

## Zod opt-in validation

The HTTP transport layer supports opt-in Zod v4 response validation at the transport boundary. Pass a `responseSchema` on individual method calls to validate the parsed response body:

```ts
import { z } from 'zod/v4';

const result = await sdk.operator.invoke('namespace.method', input, {
  responseSchema: z.object({ id: z.string() }),
});
```

This is opt-in per call. There is no global schema enforcement. Schema mismatch throws a `ContractError` (a `GoodVibesSdkError` subclass with `kind: 'contract'`).

## Entry-file gzip diagnostics

`bun run bundle:check` reports individual built SDK JavaScript entry-file
sizes during `validate`. It excludes imported dependencies and is not a
consumer bundle-size guarantee. Historical values in
`packages/engine/bundle-budgets.json` are optional references: missing, stale,
malformed or exceeded records are advisory, and new exports require no
arbitrary threshold. The command never rewrites those references.

Missing built export files and unreadable or syntactically malformed package JSON remain fatal.
The `bundle:check:strict` alias prevents an automatic build; it does not make
size references blocking. See [the reporter documentation](../bundle-budgets.README.md).

## Test coverage snapshot

[`COVERAGE.md`](../COVERAGE.md) is a generated snapshot of the root-level
`test/*.test.ts` files, produced by `scripts/print-test-coverage.ts`
(`bun packages/engine/scripts/print-test-coverage.ts > packages/engine/COVERAGE.md`). It is **not** enforced by
any CI gate, so it can drift from the actual test set. Treat it as a
human-readable index, not an authoritative coverage report.

## What tests must prove

Tests should fail on broken behavior or a concrete compatibility, safety, or
release guarantee. File length, exact source spelling, test counts, and host
speed are not substitutes for those guarantees. Use held promises and explicit
entry/completion state to prove asynchronous ordering; keep deadlines when the
production contract is itself a cancellation or watchdog budget.

Optional host features report skipped/unavailable when their prerequisites are
absent. The required exec-containment CI lane sets
`GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT=1`: unsupported prerequisites fail,
and both live sandbox fixtures must complete. A passing no-op is not proof.

Dependency vulnerability auditing and secret scanning remain required. Package
licenses and notices remain part of the published metadata; no generated SBOM
or automatic copyleft-family classifier is required by this repository.

## Release-gate failure scenarios

Maintainer-facing guidance for the most common release-gate failures:

- **Contract drift.** The contract-artifact step (`contracts:check`) fails when the SDK-embedded contract JSON no longer matches `packages/engine/contracts/artifacts`. Run `bun run refresh:contracts`, then re-run `bun run validate`.
- **Missing built export.** `bundle:check` still fails when a declared JavaScript entry file is absent. Fix or rebuild the package output. Size-reference advisories do not fail validation or require threshold changes.
- **Types resolution (attw).** `types-resolution-check` fails when the `exports` map does not resolve cleanly for a published subpath. Fix the `exports`/types wiring in `packages/engine/package.json` and re-run `bun run types:resolution-check`.

## Workers runtime verification

The `./browser` companion entry point (`createBrowserGoodVibesSdk`) is Workers-ready for Cloudflare Workers / Miniflare 4 / `workerd` (the `./web` entry is an equivalent alias, use `./browser` for new projects). CI verifies this three ways:

1. `rn-bundle` statically scans the built `web.js` and `workers.js` for forbidden identifiers (`node:*`, `Bun.*`).
2. `platform-matrix (workers)` boots the `./web` entry (the `./web` alias of the Workers-ready `./browser`) under Miniflare 4's programmatic workerd isolate and runs 9 real-runtime tests.
3. `platform-matrix (workers-wrangler)` boots the `./web` entry via `wrangler dev --local` to exercise wrangler's esbuild pipeline and `wrangler.toml`. Note that `wrangler dev --local` uses Miniflare 4 internally, so both runtime lanes share the same isolate; see `test/workers/NOTES.md` for runtime coverage boundaries.

The `./workers` entry is a small Worker bridge for daemon batch routes, Cloudflare Queue consumers, and scheduled ticks; its source-level behavior is covered by `test/cloudflare-worker-batch.test.ts`. SDK-owned Cloudflare provisioning is covered without live Cloudflare calls by `test/cloudflare-control-plane.test.ts` using an injected fake Cloudflare API client.

## Type-level tests

`bun run types:check` compiles type-level usage tests in `tsconfig.type-tests.json`. These catch public API type regressions without running the code, e.g. verifying that factory function return types are assignable to their documented interfaces.

`bun run validate` does not call `types:check` directly. It calls `bun run typecheck`, which runs two TypeScript projects and judges each by its printed diagnostics as well as its exit code. The first is `tsc -b --force` over the composite solution, every package plus `test/` and `scripts/` via `tsconfig.tests.json`; the second is `tsc -p tsconfig.type-tests.json`, the same standalone type-test project `types:check` runs alone. The `--force` flag matters because a restored CI cache or a worktree switch can leave `tsc -b`'s incremental build info believing a change-carrying file is already up to date, so it silently reports nothing. `--force` always recompiles and reports for real.

## Why each gate exists

- **contract-artifact-check.** The SDK package artifact exports must match `packages/engine/contracts/artifacts`. Source copies were removed. Implementation code is no longer copied into the SDK package.
- **error-contract-check.** The public `SDKErrorKind` taxonomy, retryable status list, and consumer-facing error-kind docs must stay aligned. Run it locally with `bun run error:check`. Internal implementation throws are allowed when they are caught and normalized at public transport/daemon boundaries.
- **Stored Jev readings.** Whether an error doc still presents 'server' as an error kind is a question of meaning read through Jev, so `error:check` stays offline by comparing each checked file with a reading stored for its exact content (etc/stale-server-kind-readings.json). After changing a checked file, run `bun run error-kinds:read` with `TYPESAFE_API_KEY` set and commit the updated readings; only a settled no passes, so a yes or an unsettled reading is fixed by rewording the text.
- **rn-bundle.** Static bundle scan. Companion surface (React Native, Expo, browser, web, workers) must be safe for Metro, Vite, webpack, and esbuild. Any `Bun.*` identifier or `node:*` import breaks mobile and browser bundlers. (Runtime verification of `./web` under workerd lives in the separate `workers` and `workers-wrangler` lanes above.)
- **bundle:check.** Reports entry-file gzip sizes and optional historical references.
  Missing built files remain fatal; numeric references are advisory and exclude
  imported dependencies. Actual package/API/export/browser compatibility checks remain required.
- **types-check.** TypeScript type inference is non-trivial for discriminated union returns. Type tests validate at compile time without runtime overhead.
