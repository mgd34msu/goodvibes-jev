# Complete Agent CI test groups

Agent CI selects the complete canonical `products/agent/src/test` inventory:

- `e2e` keeps every test below `src/test/e2e/` together.
- `headless`, `model-catalog`, and `model-readiness` retain their complete native feature files.
- Harness and routing feature groups are declared in `AGENT_HARNESS_GROUP_FILES`.
- `remaining` isolates the native catalog fixtures when the inventory requires additional hosts. `remaining-2` and subsequent groups distribute the other complete files across independent hosts, at most 240 files per group.

Recursive discovery includes future nested `.test`/`.spec` JavaScript and
TypeScript files. Only `.git`, `node_modules`, and `dist` directories are
ignored. Every file belongs to exactly one group. Empty groups, duplicate or
malformed paths, unknown groups, extra filters, and stale digests are errors.

Routing adapter cases use shared fixture helpers and separate feature files.
The engine integration cases register each consumer in its own file. This
preserves their behavioral assertions while allowing each feature suite to
finish within the existing runner deadline.

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

Grouping changes cross-file process state. Independent test fixtures must
initialize and restore the state they own. Qualification runs every generated
group, including the compiled terminal cases, and accounts for the complete
file census and reported outcomes. Selection and lifecycle tests execute real
children to verify isolation, failure propagation, cleanup, and completion
of the CI gate. They do not substitute for the functional product suites.
