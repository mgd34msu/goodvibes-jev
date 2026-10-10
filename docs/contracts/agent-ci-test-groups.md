# Complete Agent CI test groups

Agent CI runs the same canonical `products/agent/src/test` inventory in five
separate-host, sequential Bun children:

- `e2e`: every test below `src/test/e2e/`, together
- `headless`: the entire `src/test/cli/native-headless-entrypoint.test.ts`
- `model-catalog`: the entire `src/test/tools/agent-model-catalog-search.test.ts`
- `model-readiness`: the entire `src/test/tools/agent-model-readiness-judgment.test.ts`
- `remaining`: every other canonical test file

At repair base `efd3ffb81f27104091ad5635953b32f49be249c8`, these groups
contain 11, 1, 1, 1, and 635 files: 649 files exactly once. Counts are observations, not
hard-coded selection limits. Recursive discovery includes future nested
`.test`/`.spec` JavaScript and TypeScript files, including E2E helper suites;
only `.git`, `node_modules`, and `dist` directories are ignored. Empty groups,
duplicate or malformed paths, unknown groups, extra filters, and stale digests
are errors.

The two full-source model suites have independent hosts because the original
`remaining` job reached its unchanged 720-second ceiling while making progress.
In CI run `38072829179`, job `114274086894`, catalog search completed 121 tests in
288.5 seconds; readiness had completed 197 tests when the shared lane ended.
This is an execution partition change, not a test deletion, source-protection
shortcut, increased timeout, or claim that the interrupted run passed. Their
within-file lifecycle and every test remain intact. New nested files, including
paths that merely end with these filenames, are still discovered exactly once.

The later run `38074959951` completed that same old `remaining` grouping in
674.66 seconds: 7,467 pass, one skip and five failures across 637 files. Thus the
earlier ceiling was real, but not reached on every run. Independent model groups
provide runtime margin without changing coverage. The five failures comprised
two stale parity fixtures and three stale security-ingress expectations; their
repairs retain protected-source refusal, typed errors and zero getter/trap effects.

## Discovery and execution

The build job emits and uploads `agent-test-manifest.json`. Its SHA-256 binds
both the sorted complete inventory and group membership. Every generated
matrix row carries that digest; the grouped runner independently rediscovers
and checks it before launching tests. Each selected file is passed as an
explicit `./src/test/...` path, preventing Bun substring-filter collisions.

The grouped entrypoint is `packages/engine/scripts/agent-test-partitions.ts`:

```sh
bun packages/engine/scripts/agent-test-partitions.ts manifest
bun packages/engine/scripts/agent-test-partitions.ts matrix
bun packages/engine/scripts/agent-test-partitions.ts run --group=e2e --manifest-sha256=<build digest>
```

After validation it imports the existing engine `scripts/test.ts` in the same
process, supplying the existing Agent `--cwd` and explicit selected paths.
There is no replacement runner or synchronous wrapper around its lifecycle.
The existing workspace lock, isolated environment, Agent bunfig preload,
network guard, heartbeat/parent-death watchdog, output draining, and owned
external temporary-directory cleanup remain authoritative. Defaults stay
720 seconds overall, 180 seconds without a test starting, and 60 seconds per
test; existing individual test allowances remain unchanged. Each hosted group
retains the previous 15-minute job budget. No timeout is increased.

The unqualified local `bun run products:test agent` command is unchanged and
still runs the full directory in one child. The older Agent `scripts/run-tests.ts`
excludes E2E and is deliberately not used. Other product commands and dynamically
inspected catalog validation are unchanged; the CI-only `matrix-without-agent`
mode moves Agent to its dedicated groups and refuses an absent Agent workspace.

## Artifact and gate integrity

Each Agent leg restores the single build job's exact workspace/compiled Agent
artifact, verifies its commit, payload hashes and executable modes with
`ci-artifact.ts`, and runs the binary's version smoke. The same binary is supplied
through `GOODVIBES_E2E_BINARY`. Every leg retains tmux installation and the CI git
identity setup, so actual compiled terminal tests are not replaced with source
or synthetic terminal substitutes.

The matrix has `fail-fast: false`. `Product tests (agent)` remains the stable
external check name: its always-running aggregate requires both the build and
all Agent legs to succeed. Failed, cancelled, or skipped dependencies fail that
check. Auto-release requires the Agent matrix and aggregate as well as the
unchanged other product matrix and all existing release dependencies.

## Qualification boundary

This intentionally changes cross-file process grouping and supplies a sorted
explicit inventory. It does **not** claim to preserve Bun's former directory
traversal order or cross-file process state. Within-file tests/hooks are not
split or edited, and the complete E2E group stays together. Qualification must
run all five exact-head hosted groups, including actual compiled PTY cases,
and account for the union's file counts and pass/skip/TODO/failure totals.
Focused infrastructure tests prove selection, future discovery, independent
inventory equality, stale inventory and old-grouping digest rejection, nested suffix collision avoidance,
real-child preload/isolation/temporary cleanup, skip/TODO retention, failure
propagation, unchanged budgets and fail-closed gate truth tables. They are not a
substitute for the complete grouped product run or evidence that a killed run
finished its assertions.
