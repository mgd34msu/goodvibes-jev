# goodvibes-jev

goodvibes-jev is a Bun and TypeScript monorepo for the GoodVibes platform: a shared engine, the Jev judgment foundation, a daemon, a terminal UI, an operator agent and a browser UI. Jev (TypeSafe's System One judgment model) handles semantic interpretation and work verification; code handles explicit permissions, formats, identity and execution bookkeeping.

The suite builds and installs from this checkout. Integration and product acceptance remain in progress; an installed build or passing focused checks do not certify full product readiness.

It replaces five separate repositories:

| Old repository | Becomes |
|---|---|
| goodvibes-sdk | `packages/engine` |
| goodvibes-daemon | `products/daemon` |
| goodvibes-tui | `products/tui` |
| goodvibes-agent | `products/agent` |
| goodvibes-webui | `products/webui` |

The scope of record is [`goodvibes-jev-intent.md`](goodvibes-jev-intent.md).

## Current decision contract

The [autonomous Jev decision contract](docs/design/autonomous-jev-decisions.md)
records the October 3 direction and supersedes older human-confirmation and
owner-escalation designs. These are target requirements, not a claim that all
callers already implement them:

- Jev automates interpretation, planning, repairs and execution choices. It does not decide whether a user prompt reaches the model or whether the model may use a tool. Tool permissions follow explicit owner configuration; Jev uncertainty or unavailability cannot veto a valid tool call.
- One shared judgment-port transport implementation owns transient Jev
  unavailability. A primary-only route retries until recovery or cancellation.
  An explicit failover chain tries compatible targets once and returns typed
  `unavailable` when every target fails. Products render waiting progress and
  terminal errors. They must not add local retry loops, prompt for approval or
  synthesize a semantic answer during an outage. Permanent
  request/authentication/format failures remain explicit operational failures.
- Code still enforces authentication, capability/scope membership, revocation,
  fixed formats, monetary arithmetic and execution idempotency. A Jev receipt
  cannot grant authority or bypass these boundaries.

Provisioning, account login and user cancellation remain legitimate product
interactions. This runtime contract does not change development-tool permissions
or authorize live external actions by a developer.

## Layout

```
packages/judgment   the level 0 Jev foundation
packages/engine     the platform library (the old sdk, renamed "the engine")
products/daemon     composition root, verbs, CLI, packaging
products/tui        the terminal UI over the engine
products/agent      the agent over the engine
products/webui      the web UI over the daemon contract
docs/contracts      runtime and integration contracts
docs/design         subsystem designs and migration decisions
```

A product holds its rendering, input capture, composition root and packaging. Platform behaviour lives in the engine.

## Status

As of October 30, 2026, all four products are executable workspaces included in
the root build, typecheck and test commands. The products are private packages;
install this suite from source using the repository installer. Product guides
also retain labelled upstream history, which is not a registry-install or release
claim for this monorepo.

The upstream targets and implementation sequence are recorded in
[`docs/design/upstream-reconciliation.md`](docs/design/upstream-reconciliation.md).

- **Judgment:** the shared port, autonomous receipt validation, decision log,
  patterns and calibration tooling are implemented. Primary-only transient
  outages wait for recovery or cancellation; explicit failover returns typed
  `unavailable` on exhaustion. Permanent request, authentication, format and
  decision-log failures remain terminal.
- **Conversation and tools:** TUI composer input and `--prompt` reach the
  selected conversation model directly. Tool admission follows owner settings
  and deterministic authority checks. Explicit native work intake remains a
  separate route, with durable source identity and recovery.
- **Completion and reviews:** the engine decides whether task completion
  verification applies to the current request, retains private repair findings,
  and checks evidence before publication. Contract project reviews track native
  file inventory, read observations and accepted assessments separately. See
  [runtime orchestration](packages/engine/docs/runtime-orchestration.md#completion-verification)
  and [review inventory](packages/engine/docs/contract-criteria.md#project-review-inventory).
- **Product integration:** daemon composition, native work controls, TUI, Agent
  and WebUI are implemented to differing degrees. Connected-host setup, legacy
  caller migration, live-provider qualification and end-to-end product acceptance
  still require validation against the candidate being released. Synthetic
  checks establish only the behavior and configuration they exercise.

## How each old module is handled

Per-module source dispositions and migration decisions are recorded in [Linear](https://linear.app/the-artificery/issue/TA-14/port-daemon-tui-agent-and-webui-with-preserved-parity).

The disposition vocabulary is:

| Disposition | Meaning |
|---|---|
| PORT | Carried over with its behaviour and interface intact; only its imports change. |
| JEV | Carried over, with its guessed decisions replaced by Jev readings. |
| HOIST | A product module that is really platform behaviour; it moves into the engine. |
| DROP | Not carried over, with a recorded reason. Includes WRFC-specific code replaced by the contract runner, QEMU sandboxing, and owner-authorized removal of unnecessary test/CI infrastructure. Actual behavioral obligations remain explicit. |

The upstream product interfaces are the parity target, including the October 1 redesign recorded in the source snapshots. Screens, panels, commands and styles carry over while their shared behavior uses the Jev engine. Runtime human-approval and escalation interactions must migrate to the current autonomous contract; preserving an upstream view does not preserve its superseded decision semantics.

## The judgment foundation (`packages/judgment`)

The workspace package `@goodvibes-jev/judgment` provides:

- **The judgment port.** One interface every decision site calls, over the System One API, against the hosted Jev endpoint or a local System One model with the same wire protocol.
- **Typed readings.** Yes/no, a choice over fixed options, and a score on a rubric. Existing stake-scaled bands retain the legacy `act`, `confirm` and `escalate` vocabulary for unmigrated callers and historical records; these are not autonomous consumer outcomes.
- **Autonomous receipts.** The runtime-neutral `@goodvibes-jev/judgment/decisions` entry point supplies the shared `JevDecision` schema and structural/binding validation. It does not itself supply the semantic evaluator, live authorization or atomic execution claim.
- **Batteries.** Named decisions that keep their questions, bands, fixtures and calibration policy in one reviewable definition.
- **Patterns and compound patterns.** Dispatch, judging output against a goal, rerank, existence checks, reply reading, entity alignment, fidelity checks, policy checklists, candidate selection and date-parts extraction, plus compounds that combine them in code.
- **The decision log.** SQLite, one entry per reading, queryable by battery, time range and outcome.
- **Calibration.** Runs every battery's fixtures live and reports accuracy against confidence. It fails when a battery falls below its floor.

The old heuristics are being removed, not kept as backups. Legacy uncertainty must never be promoted to `act` or relabeled as approval. The default port uses one configured System One endpoint. Explicit failover chains and persisted fallback settings are supported; live calibration remains unfinished. The [judgment package README](packages/judgment/README.md) documents primary-only retries, configured failover exhaustion, owned cancellation and terminal permanent failures. Products must consume that shared lifecycle and preserve cancellation and zero effects while waiting; transport recovery does not establish autonomous consumer migration or live-provider proof.

## The engine (`packages/engine`)

The old sdk's packages keep their directories under `packages/engine/<package>/src`:

- `contracts`
- `daemon-sdk`
- `errors`
- `operator-sdk`
- `peer-sdk`
- `sdk`
- `terminal-shell`
- `toolchain`
- `transport-core`
- `transport-http`
- `transport-realtime`

Each one is imported as `@goodvibes-jev/engine/<package>`. The platform subsystems live in `packages/engine/sdk/src/platform/`.

Beyond the ported code, the engine's target architecture adds:
- **routing:** reads each request's tier, intent, difficulty, risk, domain and language before tokens are spent, and picks a route from the whole model catalog.
- **tool execution:** owner-configured permissions, workspace scope, schema validation and cancellation apply across native and external tools. Jev helps carry out the work; it is not a second permission authority.
- **observe:** analytics over the decision log: accuracy against confidence, threshold sweeps, drift and question discovery.
- **the contract runner:** replaces the old write, review, fix, check (WRFC) loop.

### The contract runner

The target workflow is:

1. A planning model sets a goal and acceptance criteria for the task, then breaks the work into groups and units, each with its own criteria.
2. Sub-agents do the units. Jev checks each unit against its criteria and quality while the sub-agent works.
3. When a unit misses a requirement or is poor quality, the sub-agent is told what is wrong, fixes it, and Jev checks again. Work can pass only with evidence that the criteria are met.
4. Correction that stalls is resolved by Jev through autonomous revision/evidence gathering, deferral on a registered condition, or refusal. It never opens a human approval or owner-escalation loop.
5. Each group is judged when its units complete, and the whole deliverable is judged at the end.

The runner is designed to run as a CLI and as the daemon's hosted-session host. [`docs/design/contract-runner.md`](docs/design/contract-runner.md) retains the detailed earlier design and implementation history; its owner-reply/escalation paths still need migration under the current autonomous contract.

## Requirements

- **Bun:** 1.3.14.
- **Node:** 22 or later, for the tooling that runs under Node.
- **`TYPESAFE_API_KEY`:** needed for anything that calls Jev live: the proofs, calibration and a running engine.
- **`TYPESAFE_BASE_URL`:** optional. Set it to a loopback address to use a local System One model instead of the hosted endpoint.

## Install the application

On Linux x64/arm64 with glibc, run the installer as your normal user from a
checkout with no uncommitted changes to tracked files:

```bash
read -rsp 'TypeSafe API key: ' TYPESAFE_API_KEY; echo
export TYPESAFE_API_KEY
./install.sh
unset TYPESAFE_API_KEY
goodvibes
```

It builds the suite, verifies Jev connectivity, pairs the TUI to the local
daemon, registers the selected workspace and creates a systemd user service.
Bun and Node runtimes are supplied when needed. The daemon serves the WebUI at
`http://127.0.0.1:3421`. Provider accounts for the conversation model are
configured separately. See [installation instructions](docs/installation.md)
for prerequisites, credentials, custom paths and service options.

Run `goodvibes-uninstall` (or `./uninstall.sh`) to remove the application and
service while keeping your data. Add `--purge` to delete the data too.

## Common commands

Run these from the repository root:

```sh
bun install
bun run typecheck                               # every package
bun run build                                   # judgment, engine and all four products
bun run test                                    # installer, judgment, engine and product tests
bun run products:check                          # product entrypoints, exports and type coverage

bun run --cwd packages/judgment proof           # live proof of every pattern and compound
bun run --cwd packages/judgment calibrate       # live calibration of every battery
bun run --cwd packages/engine routing:proof     # live routing proof against the model catalog
bun run observe:report                          # decision-log analytics
bun run judgment:lint                           # registration/fixture checks across engine and product TS/TSX
bun run judgment:audit --json                    # semantic review candidates; not a coverage certificate
```

The root `prepare` script points git at `.githooks/`. The local pre-commit hook runs the source-only credential scope check for engine and product implementation/config changes. Run focused behavior tests during development and `bun run validate` for a complete local integration check. Required CI still runs the full build, types, API, product, browser and containment checks against the reviewed commit. A successful commit alone does not establish merge readiness.

## Documentation

- [Installation, updates, services and uninstall](docs/installation.md)
- [Terminal UI](products/tui/README.md) and [CLI flags](products/tui/docs/cli-flags.md)
- [Agent](products/agent/README.md) and [first-start readiness](products/agent/docs/setup-native-readiness.md)
- [Daemon](products/daemon/README.md) and [configuration](products/daemon/docs/configuration.md)
- [WebUI](products/webui/README.md) and [operator guide](products/webui/docs/operator-guide.md)
- [Engine documentation](packages/engine/docs/README.md) and [judgment foundation](packages/judgment/README.md)
- [Security policy](SECURITY.md) and [current autonomous decision contract](docs/design/autonomous-jev-decisions.md)

## License

MIT.
