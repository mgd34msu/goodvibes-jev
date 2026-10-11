# Test infrastructure and build-preparation contracts

## Owned cleanup and fixtures

Shared fixtures use the actual engine owners rather than unused product copies.
The [disposable registry](../../../packages/engine/test/_helpers/disposables.ts)
registers hooks in each caller file's scope. Its default is `afterEach` with an
`afterAll` backstop; explicit all-file scope uses `afterAll`. Disposal is LIFO,
drains all entries despite failures, reports aggregate failures and is idempotent.
An explicit disposer takes precedence. Otherwise bare callbacks and the first
available `dispose`, `stop`, `close`, `destroy`, `shutdown`, then `Symbol.dispose`
are supported. Unsupported values are refused rather than silently leaked.

The [provider-cache fixture](../../../packages/engine/test/_helpers/provider-cache.ts)
accepts a validated allocation prefix, never an arbitrary caller-owned cache path.
`makeProjectTempDir` creates a fresh runner-owned root. Both the root registry and
cache directory retain their identities; cleanup refuses replacement directories
or symlinks and reports survivors. Normal repeated cleanup is harmless. Catalog
fixtures use the current version 5 format; benchmark fixtures use version 1.
The shared writer preserves arbitrary model data, supplied timestamps/TTLs and
existing benchmark seeder destination/defaults. Real catalog-loader and provider
composition controls remain distinct from fixture-allocation tests.

Authenticated-WebSocket and settings-control-plane test helpers remain owned by
Agent. Liveness and session-surface helpers remain owned by TUI; TUI session
identity is not a compatibility claim for daemon identity. Liveness includes
renderer glyph/style support, and session-surface snapshots retain the existing
ten-minute-plus-offset aging. A shared helper's successful component test does
not establish that every product caller or whole runtime graph is equivalent.

Daemon graph fixtures explicitly await graph creation and shutdown. Validation
must check stable services identity within one graph, distinct successive graphs,
more than three active intervals in each successive graph, complete drainage and
repeatable shutdown. A disposable-suite
crosswalk is not permission to recreate implicit singleton/getter/reset wrappers
or legacy WRFC state helpers.

## Owned temporary roots

The canonical `makeProjectTempDir` requires the official runner-owned root; raw
invocation fails before creating checkout scratch. Child startup redirects the
standard temporary-directory variables before imports and descendants. Registry
cleanup performs bounded late-write rechecks and reports survivors. The parent
waits for the child, output streams and ordinary owned process group to stop
before deleting its identity-pinned root. Failure and abrupt-exit paths retain
that finalizer. Uncertain process-group teardown retains marked evidence instead
of deleting a potentially live tree.

This is not an arbitrary child-authored path-list deletion interface.
`TEST_TEMP_MANIFEST_ENV`, `parseTempManifest`, attempted-path return lists and
`removeManifestedTempDirs` are not supported cleanup authority. Missing or
malformed handoff data cannot widen or suppress the parent's own identity check.
An outside-root file survives, including when `GOODVIBES_TEST_TEMP_MANIFEST`
names it. Foreign manifest bytes also remain unchanged.

The dead-owned-run sweep recognizes ownership records, live/dead PIDs, inode
identity, symlinks and evidence markers. It does not adopt legacy filename
prefixes or authorize deletion of unowned historical, production or external
editor scratch. Such cleanup needs trustworthy ownership and separate explicit
scope; a prefix-only recursive remover is not an equivalent implementation.
Tests retain hard-killed-parent recovery, swapped-root/link refusals, interrupted
children, descendant termination and a late writer unable to recreate the root.

## Installed dependencies and compiled verification

The daemon resolves its installed `@goodvibes-jev/engine` workspace dependency,
then resolves optional operations through that engine's declared dependency graph.
Operation tests create/insert/select/close an actual SQL database, create and reload
a JSZip entry, parse a TypeScript declaration through ast-grep, resolve all named
WASM assets and initialize web-tree-sitter. Asset coverage includes TypeScript,
TSX, JavaScript, Python, JSON, CSS and the web-tree-sitter runtime. Import-only or
copied package-pin checks do not establish those operations. SQL source-runtime
initialization does not establish the separate compiled SQL-worker embedding.
The obsolete fuzzy-search fixture is not a substitute for semantic registry
reranking and must not reintroduce the removed matcher or old package-pin gates.

`verify-binary.mjs` and `boot-smoke-reading.mjs` check the relocated executable,
HTTP status/running state, exact package version and intended/bound endpoint,
absence of the mismatch diagnostic, malformed-settings failure with exact file
and reason, native-addon relocation, real memory add/search and contextual addon
diagnostics. The diagnostic reader uses the complete bounded evidence and the
canonical Jev battery: its verdict must be `no`; uncertainty refuses. Word
co-occurrence or a regex approximation does not establish that semantic result.

A compiled receipt is valid only for its exact verifier and artifact bytes.
Scripted diagnostic responses are synthetic evidence, not live calibration.
Changing a combined source or artifact requires fresh applicable qualification;
a historical successful log cannot qualify different bytes. Native vector and
round-trip checks, current affected tests/types, SQL maintenance/native proof and
aggregate release gates are separate obligations.

## Build preparation and workspace identity

The canonical engine compile driver applies compatibility patches in memory; it
does not edit installed dependencies. SQL compatibility must match the installed
released loader/WASM pair and refuse an unexpected shape. Ordinary native
prebuild runs `check-version.ts` and refuses version drift without mutating the
manifest or fallback source. Only explicit `release:prepare` performs version,
README and changelog preparation; see [release preparation](testing-and-validation.md#explicit-local-release-preparation).
Automatic write-on-build is intentionally unsupported.

Release preparation's read/validate/write/rollback transaction and the actual
native build wrapper child lifetime share one canonical strict product lock.
Writers serialize, aliases share ownership, failures release it, live owners are
not stolen, exited owners can be reclaimed, and malformed ownership refuses
before lock mutation. This is not a hard-kill descendant guarantee or cross-file
crash-atomic transaction. Source preparation does not choose version/release
policy, publish, or configure update distribution.

The product uses `workspace:*`. The native wrapper resolves the workspace engine's
declared CLI through `createRequire`, refusing absent or undeclared tools rather
than selecting a global fallback. External SDK checkout discovery,
`GOODVIBES_SDK_PATH` overlays and the old `sdk-dev` forwarding API are not retained.
The [upstream changelog](history/upstream-CHANGELOG.md) is a historical archive;
its old release/security/WRFC claims are not current product guarantees or an
active product changelog/release gate.

## Structural checks and ignored outputs

Root `architecture:check` invokes the shared runtime SCC and dependency-boundary
checks. Daemon execution CLI modules are composition roots; other CLI modules
remain catalog-layer by default. The mapped cluster owners are terminal-shell
sources. Missing layers or owners refuse. Parsing retains value edges beside
erased type imports and resolves `.js` specifiers to TypeScript source. Coverage
is relative-import based, not package-alias cycle coverage. Removed quota, style,
`any`, mock and pattern-count gates are not part of this contract.

The shared workflow checker discovers `.yml` and `.yaml`. Empty/non-map/malformed
documents, missing name/on/nonempty jobs, non-map jobs and executing jobs without
`runs-on`/steps refuse. Reusable `uses` jobs keep their exemption. Job-level true
or potentially true `continue-on-error` refuses; explicit false and step-level
flags retain their existing behavior. These structure checks do not replace
actual CI execution, build/import/type tests, or release qualification.

The product `.gitignore`, root rules and shared-test scratch owners protect current
native/native-lib output while leaving maintained vendor source, platform
scaffolds, ordinary tmp-source/test-tmp source names and technical documents
visible. Private environment/encrypted files stay ignored inside intentionally
visible skill/agent resource families. Obsolete blanket exclusions for generated
README backups, retired reset scripts and local probe reports are not revived.
Actual Git-rule evaluation must include negative controls for exposed private
files and wrongly hidden source exceptions.

## Focused validation

From the repository root, use the workspace-lock-owning wrapper:

```sh
bun packages/engine/scripts/test.ts test/disposables.test.ts \
  test/provider-cache-fixture.test.ts test/temp-cleanup.test.ts \
  test/project-temp.test.ts test/test-tmp-containment.test.ts \
  test/runtime-import-architecture.test.ts test/workflow-shape.test.ts
bun packages/engine/scripts/test.ts --cwd ../../products/daemon \
  src/test/deps/installed-source-parity.test.ts \
  src/test/runtime/daemon-fixture-boot.test.ts \
  src/test/scripts/build-preparation-lock.test.ts \
  src/test/scripts/native-packaging.test.ts src/test/scripts/gitignore.test.ts
```

These focused source controls do not replace the [workspace validation and native
artifact procedures](testing-and-validation.md) or [installation/rollback
contract](local-native-installation.md). Synthetic fixtures do not establish
live-provider calibration or native execution on every supported platform.
