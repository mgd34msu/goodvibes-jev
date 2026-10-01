# goodvibes-jev

goodvibes-jev is the goodvibes platform rebuilt as one Bun monorepo, with Jev (TypeSafe's System One judgment model) making the decisions the old code made by guesswork. Keyword lists, regexes over prose, length cutoffs and guessed classifications become typed Jev readings. Everything else goodvibes does carries over unchanged.

It replaces five separate repositories:

| Old repository | Becomes |
|---|---|
| goodvibes-sdk | `packages/engine` |
| goodvibes-daemon | `products/daemon` |
| goodvibes-tui | `products/tui` |
| goodvibes-agent | `products/agent` |
| goodvibes-webui | `products/webui` |

The scope of record is [`goodvibes-jev-intent.md`](goodvibes-jev-intent.md).

## Layout

```
packages/judgment   the level 0 Jev foundation
packages/engine     the platform library (the old sdk, renamed "the engine")
products/daemon     composition root, verbs, CLI, packaging
products/tui        the terminal UI over the engine
products/agent      the agent over the engine
products/webui      the web UI over the daemon contract
docs/inventory      every old module and what happened to it
docs/design         designs for new subsystems (the contract runner)
docs/audit          audits of what the judgment foundation covers
```

A product holds its rendering, input capture, composition root and packaging. Platform behaviour lives in the engine.

## Status

The work is tracked in the Finish GoodVibes Jev Linear project. The current
upstream targets and implementation sequence are recorded in
[`docs/design/upstream-reconciliation.md`](docs/design/upstream-reconciliation.md).

- **`packages/judgment`:** built.
- **`packages/engine`:** in progress. It holds the whole sdk tree, and its subsystems are being converted one at a time.
- **The contract runner:** in progress.
- **The products:** the daemon has a working partial composition and command
  adapters in `products/daemon`. The redesigned WebUI workspace in `products/webui`
  builds and runs synthetic browser and LAN scenarios; its remaining semantic
  decisions, connected flows and full parity are still in progress. TUI and Agent
  ports are in development and are not yet published workspaces. Ordinary CI
  checks implemented behavior; it does not establish full product parity.

## How each old module is handled

Every module in the old repositories gets exactly one disposition, recorded in `docs/inventory/`:

| Disposition | Meaning |
|---|---|
| PORT | Carried over with its behaviour and interface intact; only its imports change. |
| JEV | Carried over, with its guessed decisions replaced by Jev readings. |
| HOIST | A product module that is really platform behaviour; it moves into the engine. |
| DROP | Not carried over, with a recorded reason. Includes WRFC-specific code replaced by the contract runner, QEMU sandboxing, and owner-authorized removal of unnecessary test/CI infrastructure. Actual behavioral obligations remain explicit. |

The upstream product interfaces are the parity target, including the October 1 redesign recorded in the source snapshots. Screens, panels, commands, styles and interactions carry over while their shared behavior uses the Jev engine.

## The judgment foundation (`packages/judgment`)

Published as `@goodvibes-jev/judgment`, it provides:

- **The judgment port.** One interface every decision site calls, over the System One API, against the hosted Jev endpoint or a local System One model with the same wire protocol.
- **Typed readings.** Yes/no, a choice over fixed options, and a score on a rubric. Stake-scaled bands turn each reading into act, confirm or escalate.
- **Batteries.** Named decisions that keep their questions, bands, fixtures and pinned model version in one reviewable definition.
- **Patterns and compound patterns.** Dispatch, judging output against a goal, rerank, existence checks, reply reading, entity alignment, fidelity checks, policy checklists, candidate selection and date-parts extraction, plus compounds that combine them in code.
- **The decision log.** SQLite, one entry per reading, queryable by battery, time range and outcome.
- **Calibration.** Runs every battery's fixtures live and reports accuracy against confidence. It fails when a battery falls below its floor.

The old heuristics are being removed, not kept as backups. Converted callers preserve typed unavailable, confirm and escalate outcomes instead of inventing an affirmative answer. The default port uses one configured System One endpoint; an injected failover transport exists, while persisted failover settings and live calibration remain unfinished. Each remaining decision site still needs its own behavior and evidence for an unavailable judgment.

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

Beyond the ported code, the engine adds:
- **routing:** reads each request's tier, intent, difficulty, risk, domain and language before tokens are spent, and picks a route from the whole model catalog.
- **gate:** the one path for every side effect. A deterministic boundary check runs first, then Jev reads the stakes. The old permission modes become presets over a stakes table.
- **observe:** analytics over the decision log: accuracy against confidence, threshold sweeps, drift and question discovery.
- **the contract runner:** replaces the old write, review, fix, check (WRFC) loop.

### The contract runner

1. A planning model sets a goal and acceptance criteria for the task, then breaks the work into groups and units, each with its own criteria.
2. Sub-agents do the units. Jev checks each unit against its criteria and quality while the sub-agent works.
3. When a unit misses a requirement or is poor quality, the sub-agent is told what is wrong, fixes it, and Jev checks again, repeating until the unit passes. Failing work is never accepted.
4. Correction that stalls becomes a planned fix or an escalation to the owner.
5. Each group is judged when its units complete, and the whole deliverable is judged at the end.

The runner is designed to run as a CLI and as the daemon's hosted-session host. The design is in [`docs/design/contract-runner.md`](docs/design/contract-runner.md).

## Requirements

- **Bun:** 1.3.14.
- **Node:** 22 or later, for the tooling that runs under Node.
- **`TYPESAFE_API_KEY`:** needed for anything that calls Jev live: the proofs, calibration and a running engine.
- **`TYPESAFE_BASE_URL`:** optional. Set it to a loopback address to use a local System One model instead of the hosted endpoint.

## Common commands

Run these from the repository root:

```sh
bun install
bun run typecheck                               # every package
bun run build                                   # build the engine and implemented products
bun run test                                    # judgment, engine and implemented product tests

bun run --cwd packages/judgment proof           # live proof of every pattern and compound
bun run --cwd packages/judgment calibrate       # live calibration of every battery
bun run --cwd packages/engine routing:proof     # live routing proof against the model catalog
bun run observe:report                          # decision-log analytics
bun run judgment:lint                           # every registered decision has fixtures; no Jev call outside one
```

The root `prepare` script points git at `.githooks/`. The local pre-commit hook runs the source-only credential scope check for engine and product implementation/config changes. Run focused behavior tests during development and `bun run validate` for a complete local integration check. Required CI still runs the full build, types, API, product, browser and containment checks against the reviewed commit. A successful commit alone does not establish merge readiness.

## License

MIT.
