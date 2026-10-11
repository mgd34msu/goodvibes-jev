# goodvibes-jev

goodvibes-jev is the goodvibes platform being rebuilt as one Bun monorepo. The target is for Jev (TypeSafe's System One judgment model) to make every semantic decision, replacing keyword lists, regexes over prose, length cutoffs and guessed classifications. Existing product behavior carries over except where the current autonomous decision contract supersedes it.

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

- Jev makes semantic decisions everywhere, with no human in the runtime decision
  loop. Its shared outcomes are `act`, `revise`, `defer` and `reject`.
- One shared judgment-port transport implementation must retry transient Jev
  unavailability until recovery with backoff and responsive lifecycle cancellation.
  Products render waiting progress; they must not add local retry loops, prompt
  for approval or synthesize a semantic answer during an outage. Permanent
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
docs/design         designs for new subsystems (the contract runner)
docs/audit          audits of what the judgment foundation covers
```

A product holds its rendering, input capture, composition root and packaging. Platform behaviour lives in the engine.

## Status

The work is tracked in the Finish GoodVibes Jev Linear project. The current
upstream targets and implementation sequence are recorded in
[`docs/design/upstream-reconciliation.md`](docs/design/upstream-reconciliation.md).

- **`packages/judgment`:** the foundation, shared autonomous receipt schema/validation and shared availability-retry transport are implemented. Transient Jev outages stay pending until recovery or owned cancellation, with per-attempt timeouts, backoff and bounded attempt history. Native runtime disposal and browser/relay cancellation use that lifecycle. Permanent request/authentication/format and decision-log failures remain terminal; autonomous consumer migration and live-provider proof remain unfinished.
- **Autonomous execution:** tool admission ([THE-118](https://linear.app/the-artificery/issue/THE-118/integrate-autonomous-jev-tool-admission)) and remembered grant scope/revocation ([THE-115](https://linear.app/the-artificery/issue/THE-115/preserve-remembered-grant-scope-and-revocation)) remain in progress as of October 3. Legacy gate, runner and product callers are migration/release gates. Shared types and passing synthetic checks do not establish autonomous execution or live-provider proof.
- **`packages/engine`:** in progress. It holds the whole sdk tree, and its subsystems are being converted one at a time.
- **The contract runner:** in progress.
- **The products:** the daemon has a working partial composition and command
  adapters in `products/daemon`. The redesigned WebUI workspace in `products/webui`
  builds and runs synthetic browser and LAN scenarios; its remaining semantic
  decisions, connected flows and full parity are still in progress. TUI and Agent
  ports are in development and are not yet published workspaces. Ordinary CI
  checks implemented behavior; it does not establish full product parity.

## How each old module is handled

Per-module source dispositions and migration decisions are recorded in [Linear](https://linear.app/the-artificery/issue/TA-14/port-daemon-tui-agent-and-webui-with-preserved-parity). The disposition vocabulary is:

| Disposition | Meaning |
|---|---|
| PORT | Carried over with its behaviour and interface intact; only its imports change. |
| JEV | Carried over, with its guessed decisions replaced by Jev readings. |
| HOIST | A product module that is really platform behaviour; it moves into the engine. |
| DROP | Not carried over, with a recorded reason. Includes WRFC-specific code replaced by the contract runner, QEMU sandboxing, and owner-authorized removal of unnecessary test/CI infrastructure. Actual behavioral obligations remain explicit. |

The upstream product interfaces are the parity target, including the October 1 redesign recorded in the source snapshots. Screens, panels, commands and styles carry over while their shared behavior uses the Jev engine. Runtime human-approval and escalation interactions must migrate to the current autonomous contract; preserving an upstream view does not preserve its superseded decision semantics.

## The judgment foundation (`packages/judgment`)

Published as `@goodvibes-jev/judgment`, it provides:

- **The judgment port.** One interface every decision site calls, over the System One API, against the hosted Jev endpoint or a local System One model with the same wire protocol.
- **Typed readings.** Yes/no, a choice over fixed options, and a score on a rubric. Existing stake-scaled bands retain the legacy `act`, `confirm` and `escalate` vocabulary for unmigrated callers and historical records; these are not autonomous consumer outcomes.
- **Autonomous receipts.** The runtime-neutral `@goodvibes-jev/judgment/decisions` entry point supplies the shared `JevDecision` schema and structural/binding validation. It does not itself supply the semantic evaluator, live authorization or atomic execution claim.
- **Batteries.** Named decisions that keep their questions, bands, fixtures and pinned model version in one reviewable definition.
- **Patterns and compound patterns.** Dispatch, judging output against a goal, rerank, existence checks, reply reading, entity alignment, fidelity checks, policy checklists, candidate selection and date-parts extraction, plus compounds that combine them in code.
- **The decision log.** SQLite, one entry per reading, queryable by battery, time range and outcome.
- **Calibration.** Runs every battery's fixtures live and reports accuracy against confidence. It fails when a battery falls below its floor.

The old heuristics are being removed, not kept as backups. Legacy uncertainty must never be promoted to `act` or relabeled as approval. The default port uses one configured System One endpoint; an explicit failover chain is supported, while persisted failover settings and live calibration remain unfinished. The [judgment package README](packages/judgment/README.md) documents shared retry-until-available, owned cancellation and terminal permanent failures. Products must consume that shared lifecycle and preserve cancellation and zero effects while waiting; transport recovery does not establish autonomous consumer migration or live-provider proof.

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
- **gate:** the one path for every side effect. Jev selects the semantic disposition from complete bound input and evidence; current deterministic authority/scope checks and an atomic execution claim still precede any effect. Legacy permission presets and approval dispatch remain migration work, not the target decision contract.
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
