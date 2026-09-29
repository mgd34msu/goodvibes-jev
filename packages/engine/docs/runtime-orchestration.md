# Runtime orchestration

GoodVibes runtime orchestration is the daemon-side loop that turns user input
into provider calls, tool execution, agent work, contract events, and persisted
session state.

Public API surfaces:

- `@goodvibes-jev/engine/sdk/platform/core`
- `@goodvibes-jev/engine/sdk/platform/runtime`
- `@goodvibes-jev/engine/sdk/platform/orchestration`

> See [Public surface reference](./public-surface.md) for stability status and the full list of exported platform subpaths.

## Turn loop

The core orchestrator owns normal chat/task turns. It resolves the active
provider/model, checks context limits, builds prompt context, streams provider
deltas, executes requested tools, reconciles unresolved tool calls, records
usage, emits runtime events, and performs post-turn context maintenance.

All SDK-owned turn paths append a small harness-awareness instruction to the
system prompt. The instruction tells the model to use `goodvibes_context`
before answering questions about GoodVibes settings, configured integrations,
host capabilities, surfaces, provider/model state, or available tools. It also
tells the model not to start agent work for ordinary questions, environment
inspection, or direct research that can be answered in the current turn with
tools.

Before the model is called, each user turn is read once by the contract
intake (`createContractIntake`, `contract/intake-route.ts`):

1. **Open escalation.** When one of the session's contracts is waiting on its
   owner, the turn's text is the owner's reply and goes to `runner.reply` for
   the newest open escalation. The turn ends there.
2. **Request route.** Otherwise Jev reads the text with `contract.request-route`
   (`converse`, `answer` or `contract`). Route `contract` at act starts a
   contract with the text as its ask, and the turn ends; the answer arrives
   when the contract's owner record completes. Any other route, or any reading
   below act, leaves the turn to the conversation model, which may still start
   a contract through the `agent` tool.

Nothing is injected into the model's prompt by this step.

Important pieces:

- `ConversationManager` stores the conversation messages for a session.
- `executeOrchestratorTurnLoop()` drives provider streaming and tool execution.
- `executeToolCalls()` routes tool calls through the registered tool runtime.
- `checkContextWindowPreflight()` protects turns that exceed model limits.
- `OrchestratorFollowUpRuntime` routes follow-up messages back into active
  sessions.
- `ExecutionPlanManager` tracks structured plans with `pending`, `in_progress`,
  `complete`, `failed`, and `skipped` statuses.

## Sessions

Session persistence lives under the configured surface root. The session layer
stores session files, recovery files, last-session pointers, lineage, and
session-directory resolution. The runtime distinguishes shared TUI sessions
from isolated remote sessions:

- Shared sessions use the daemon/TUI current provider and model.
- Companion remote sessions keep session-local provider/model selection.
- Home Assistant remote sessions are isolated and expire after the configured
  inactivity TTL.
- ntfy remote chat uses daemon-owned remote chat while ntfy chat-to-TUI uses
  the active shared session.

`POST /api/sessions/:id/messages` defaults to normal conversation routing when
`kind` is omitted. This keeps shared-session messages from becoming agent or
contract work accidentally. Callers must send `kind: "task"` when they
intentionally want session-broker task continuation and possible agent
spawning. See [Companion message routing](./companion-message-routing.md) for
the full `kind` taxonomy (`message` / `task` / `followup`) and the per-kind
response shapes.

## Agents

Agents run work outside the current assistant turn. `AgentOrchestrator` owns
agent lifecycle, provider routing, archetype loading, tool dependencies,
communication policy, channel delivery hooks, and runtime event emission.

Agent features include:

- single-agent spawn
- batch spawn
- status, list, get, cancel, wait, and message operations
- cohorts for related agents
- template/archetype loading from built-ins and `.goodvibes/agents/*.md`
- per-agent provider/model routing
- agent-to-agent communication policy
- budget and plan inspection
- channel reply tracking

The `agent` tool exposes these operations to the LLM when the host registers
the full tool runtime. Its `spawn` and `batch-spawn` modes start a contract
through the runner unless `outsideContract` is set; see [Contracts](#contracts).

## Archetypes and templates

Agent archetypes describe named worker roles. Built-ins cover orchestrator,
planner, engineer, reviewer, tester, researcher, integrator, and general.
Project-level markdown files can add or override archetypes with frontmatter
for name, description, tools, provider, model, and prompt content.

Templates provide reusable agent/task shapes for scheduler, workflow, and
sub-agent orchestration flows. A contract picks a unit's template from its
role: `engineer` for implement units, `integrator` for integration units,
`researcher` for research units, and a read-only `general` agent for design
units. The planner runs as the `planner` template.

## Contracts

A contract is the unit of checked work. The contract runner
(`@goodvibes-jev/engine/sdk/platform/contract`, `createContractRunner` in
`contract/runner.ts`) plans the work, runs it through sub-agents, and has Jev
judge it while it runs. It replaces the retired write-review-fix-confirm loop:
Jev reads the work continuously and nudges the sub-agent instead of running
separate review and fix agents. The build design is
`docs/design/contract-runner.md` at the repository root.

### Where contracts start

| Origin | Entry point |
| --- | --- |
| `turn` | The contract intake reads a person's turn as work (see [Turn loop](#turn-loop)) |
| `agent-tool` | The `agent` tool's `spawn` or `batch-spawn` without `outsideContract`; the tasks become proposed units and the result carries `contractStarted: true` and the contract id |
| `proposal` | A launched plan proposal or workstream draft, through `runner.startFromPlan`; the drafted units are kept and the planner writes their criteria |
| `cli` | The command line, `goodvibes-contract run` (`runContractCli` in `contract/cli.ts`); it follows the contract, asks the owner's questions at a terminal, and hosts the session a session-mode contract's turns run in |
| `hosted` | `contracts.start` naming a live hosted session, and the hosted external work adapter (`createHostedContractWorkAdapter`); the contract runs on the session's workspace floor. A turn in a hosted session is read by the same turn intake and starts with origin `turn` |
| `external` | `contracts.start` without a hosted session (under the `operator` session unless one is named), the operator external work adapter (`createOperatorContractWorkAdapter`), and an embedded session's spawn-mode submit |

The daemon's operator methods `contracts.list`, `contracts.get`,
`contracts.start`, `contracts.cancel` and `contracts.reply` (REST
`/api/contracts...`) act through one service across the daemon's runner and
each hosted floor's runner. A hosted session lists the contracts it started
on its record (`contractIds`), says each contract's question for its owner
and its outcome in its conversation, and sends its next turn to an open
question. The external work seam (`ContractExternalWorkAdapter`: `dispatch`,
`status`, `cancel`, `result`) maps a contract to a snapshot and a result the
same way in both adapters (`contract-work.ts` in the contracts package).

A spawn by an `AgentManager` caller that does not set `outsideContract` goes
through `runner.startForOwner`, which makes the spawned record the contract's
owner. Conversation-level helpers (the planner, conversation continuations,
the surface conversation gate) spawn with `outsideContract: true`. A unit's
own agent cannot spawn agents: units are leaves, and the contract plans
sub-work.

### Lifecycle

1. **Shape.** Jev reads the request shape (`contract.request-shape`): whether
   the person forbids delegation or writing, asks for parallel agents, or
   asks for several attempts.
2. **Plan.** A read-only planner sub-agent writes the goal, the acceptance
   criteria with the person's words each comes from, and groups of units.
   Code checks the plan's structure; Jev checks that each criterion traces to
   the ask, nothing stated is missing, each criterion is checkable, and no
   unit narrows its goal. Problems go back to the planner, then to the owner.
3. **Run.** Each group runs as a workstream on the orchestration engine, one
   work item per unit, one sub-agent per unit.
4. **Check and nudge.** While a unit's agent works, and when it tries to
   finish, Jev reads its work against the unit's criteria and a quality
   battery. Failing work is held open and the agent is told what is wrong,
   until every criterion reads met.
5. **Correct.** When nudging stops making progress, the runner plans a fix
   group, gives the unit a fresh agent, or asks the owner.
6. **Finish.** Jev judges each group, then the deliverable. When the
   deliverable passes, the runner commits the contract's work and delivers
   the answer.

How criteria move through these steps is covered in
[Contract criteria](./contract-criteria.md).

### Statuses

| Level | Statuses |
| --- | --- |
| Contract | `queued`, `shaping`, `planning`, `checking-plan`, `running`, `judging`, `fixing`, `committing`, `awaiting-owner`, `passed`, `failed`, `cancelled` |
| Group | `pending`, `blocked`, `running`, `judging`, `fixing`, `awaiting-owner`, `passed`, `failed`, `cancelled` |
| Unit | `pending`, `blocked`, `running`, `checking`, `held`, `nudged`, `fixing`, `awaiting-owner`, `held-merge`, `passed`, `failed`, `cancelled` |

A unit is `held` while a check runs at its completion point and `nudged` when
a nudge was delivered and its next turn is awaited. `held-merge` is a passing
unit whose branch has not yet merged into the contract branch, or a passing
best-of-N attempt waiting for selection.

### The owner record

Every contract has an owner `AgentRecord` with `contractRole: 'owner'`. It
runs no executor. Parents and surfaces wait on it as on any agent: its status,
`fullOutput`, `AGENT_COMPLETED` and `AGENT_FAILED` are the contract's. Unit
agents carry `contractRole: 'unit'` and `contractUnitId`; the planner carries
`contractRole: 'planner'`.

When the contract needs a decision (a plan that cannot be repaired, a stalled
unit, readings that stay unsettled, an undecided best-of-N pick), it moves to
`awaiting-owner` with a question built in code. The owner's reply, from the
conversation (the turn intake) or a host calling `runner.reply`, is read with `contract.owner-reply`
as approve, amend or reject. No reply can pass a criterion that reads unmet.

### Isolation, commit and persistence

- **Isolation.** `contract.isolation` is `auto`, `worktree` or `shared`.
  Worktree mode runs the contract on branch `contract/<short>` in
  `.goodvibes/.worktrees/contract/<short>`; each unit works in its own item
  worktree and merges into the contract branch. Shared mode runs one unit at a
  time per working tree.
- **Commit.** When the deliverable passes, `contract.autoCommit` and
  `contract.commitScope` decide whether the contract's changes are committed,
  applied as uncommitted changes, or left in place. A commit failure is a
  warning on a passed contract, never a failure.
- **Persistence.** Each contract is written to
  `.goodvibes/contracts/<contractId>.json` (`ContractStore`,
  `contract/store.ts`). At startup `resumeAll()` imports every unfinished
  contract; one whose workstream snapshot or worktree is gone is failed as a
  zombie, and the rest resume at the step they left.
- **Concurrency.** `contract.maxActiveContracts` (default 6) contracts run at
  once; the rest wait as `queued`.

### Settings

The runner reads `contract.*` (`config/schema-domain-contract.ts`,
`contract/config.ts`):

| Key | Default | Meaning |
| --- | --- | --- |
| `contract.autoCommit` | `true` | Commit the deliverable when it passes |
| `contract.commitScope` | `scoped` | `off`, `scoped` (the contract's changes only) or `all` |
| `contract.gates` | typecheck and lint on, build off | Quality gate commands run at each completion check |
| `contract.gateTimeoutMs` | `120000` | Timeout per gate |
| `contract.acceptanceStakes` | `high` | Which declared pass band the judges use: `high` or `critical` |
| `contract.midRunChecks` | `true` | Check a unit after turns that write, edit or run commands |
| `contract.evidenceNudgeLimit` | `2` | Unsettled checks before the owner is asked |
| `contract.stallLimit` | `3` | Consecutive checks without progress that make a stall |
| `contract.maxNudgesPerUnit` | `12` | Nudge ceiling per unit |
| `contract.maxFixRounds` | `5` | Fix groups plus fresh agents before the owner decides |
| `contract.planRepairLimit` | `2` | Planner repairs before the owner decides |
| `contract.maxUnits` | `64` | Units per plan |
| `contract.defaultAttempts` | `1` | Attempts per unit without an explicit ask |
| `contract.maxActiveContracts` | `6` | Contracts running at once |
| `contract.maxParallelUnits` | `64` | Units running at once in one group (worktree mode) |
| `contract.isolation` | `auto` | `auto`, `worktree` or `shared` |
| `contract.heartbeatTimeoutMs` | `0` (off) | Silence before a unit agent is restarted |
| `contract.transportRetryLimit` | `1` | Fresh agents after a network failure |
| `contract.transportRetryDelayMs` | `5000` | Wait before that retry |
| `contract.nudgeTtlMs` | `300000` | Lifetime of a mid-run nudge on the message bus |
| `ui.contractMessages` | `both` | Where `[Contract]` system messages show: `panel`, `conversation` or `both` |

A settings file that still holds the retired loop's keys is migrated once on
load (`applyContractSettingsMigrationPass`, `config/manager-migration-passes.ts`):
each key moves to its `contract.*` counterpart (the heartbeat timeout to
`contract.heartbeatTimeoutMs`, the fix-attempt limit to `contract.maxFixRounds`,
the message placement to `ui.contractMessages`), and the old score threshold is
removed with a migration receipt, since acceptance is now a per-criterion
reading whose strictness is `contract.acceptanceStakes`.

### Events and fleet

Contracts report on the `contracts` runtime event domain (`CONTRACT_*` types,
`packages/engine/sdk/src/events/contract.ts`); every type is listed in the
[Runtime events reference](./reference-runtime-events.md#contracts). The
fleet shows `contract`, `contract-group` and `contract-unit` nodes, with each
criterion's latest verdict on the node's check summary. The fleet verbs
`fleet.graph.get`, `fleet.attempts.*` and `fleet.conflicts.*` take
contract-qualified ids, `<contractId>:<id>`, because every contract names its
groups `g1`, `g2` and its units `u1`, `u2`.

## Orchestration engine

`@goodvibes-jev/engine/sdk/platform/orchestration` is the phase/work-item
pipeline the contract runner runs on: one engine per contract, one workstream
per contract group, one work item per unit. A workstream holds one or more
ordered phases, each with a `PhaseKind` that determines the role of the agent
serving it. A work item advances to its next phase the instant that phase's
gate passes, claimed by whichever capacity slot is free next.

| Phase kind | What the phase does |
| --- | --- |
| `plan` | Decompose or design before implementation begins |
| `engineer` | Implement the work item; a contract unit runs as one `engineer` phase |
| `gate` | Apply a pass/fail quality check; served by a general-role agent |
| `integrate` | Merge finished work items into the combined result |
| `custom` | A host-defined phase that fits none of the built-in kinds |

The engine does not judge work. For a contract work item, the phase waits on
the runner's settlement of the unit, which passes only when Jev reads every
criterion met.

Beyond the phase pipeline itself, the engine provides:

- **Best-of-N attempts.** A work item declared with `attempts: N` runs N
  independent siblings in isolated worktrees. A passing sibling is held
  rather than auto-merged; once every sibling in the group finishes, Jev
  selects a winner (`contract.best-of-n`) or the owner picks one, and it is
  merged through the normal integration lane while the other worktrees are
  cleaned up.
- **Elastic fleet sizing.** A ready task with no available agent spawns one,
  up to a configured fleet ceiling; hitting the ceiling is a visible "N
  ready, M running, at cap" state rather than a silent stall, and an agent
  with nothing left to claim retires instead of idling.
- **Budget ceilings.** Spend is checked before a work item is claimed into a
  new phase, never mid-phase, so an in-flight phase always finishes even if
  a later item would be refused for budget reasons.
- **Dynamic dependency graphs.** Dependency and conflict-serialization edges
  can be added while a workstream is running, with orphan detection and
  cycle prevention.

Workstream state is snapshotted for resume across restarts, under
`.goodvibes/orchestration/<contractId>/` for a contract's engine. Drafts (a
workstream not yet launched) are held in a capped, swept store so a proposed
plan can be edited before it runs; launching a draft starts a contract with
`runner.startFromPlan`.

## Runtime events

The runtime bus publishes typed events for turns, sessions, agents, contracts,
tools, communication, providers, routes, state, security, telemetry, and
integration delivery. Clients consume these through the operator realtime
transport, control-plane event streams, or surface-specific streams.

Turn stream events are scoped to provider iterations. `STREAM_START` and
`STREAM_END` carry `scope: "provider"` and `terminal: false`; a single logical
turn can emit more than one stream pair when the model requests tools and then
continues after tool results. Clients that need to flush partial rendering or
audio can react to `STREAM_END`, but they must keep the turn alive until
`TURN_COMPLETED`, `TURN_ERROR`, `TURN_CANCEL`, or `PREFLIGHT_FAIL`.

Generated event schemas live in
[Runtime events reference](./reference-runtime-events.md).

## OpenAI-compatible ingress

The authenticated daemon exposes an OpenAI-compatible ingress at `/v1` by
default. This is an interoperability layer for tools that already know how to
call OpenAI's Chat Completions API and need a simple way to send prompts
through the GoodVibes daemon before they have a native GoodVibes integration.

Supported routes:

- `GET /v1/models`
- `POST /v1/chat/completions`

Set the client base URL to the daemon prefix, for example
`http://127.0.0.1:3421/v1` (default control-plane port; configurable via `controlPlane.port`), and use the daemon bearer token as the API key.
The route accepts `goodvibes/current` and provider-qualified registry keys such
as `openai:gpt-5.4`. Streaming responses use
OpenAI-style `text/event-stream` chunks ending with `data: [DONE]`.

This layer is intentionally narrow. It maps OpenAI-style requests to the active
GoodVibes provider registry for direct provider calls; it is not a replacement
for native GoodVibes sessions, tools, surfaces, agent routing, Home Graph, or
control-plane APIs. Configure it with:

- `controlPlane.openaiCompatible.enabled`, default `true`
- `controlPlane.openaiCompatible.pathPrefix`, default `/v1`

## Hooks

Hooks attach host-defined behavior to runtime events. Hook paths use:

```text
<phase>:<category>:<specific>
```

The phase says when a hook fires relative to the event it names, and what its
result may do.

| Phase | When it fires and what it can do |
| --- | --- |
| `Pre` | Before the action; its result can allow, deny, or ask, and can modify the tool input |
| `Post` | After the action completes |
| `Fail` | When the action errors |
| `Change` | When observed state changes |
| `Lifecycle` | On lifecycle transitions such as startup and shutdown |

Supported categories are tool, file, git, agent, compact, llm, mcp, config,
budget, session, contract, permission, transport, and communication; each is
the event namespace its name says. Contract events fire as
`Lifecycle:contract:<specific>` (for example `Lifecycle:contract:nudged`), and
a refused spawn fires `Change:contract:spawn-guard`.

Five runner types execute hooks, differing in where the handler logic lives.

| Runner | How it executes |
| --- | --- |
| `command` | Runs a user-authored shell command with the event available to it; commands execute with full process privileges by design |
| `prompt` | Sends the event JSON into an LLM prompt template and parses the response as the hook result; a non-JSON response means fire-and-forget success |
| `agent` | Spawns a subagent whose task is the prompt template with the event substituted in, waiting up to the hook's timeout |
| `http` | POSTs the event JSON to a configured URL and parses the response as the hook result |
| `ts` | Loads a TypeScript module whose default export handles the event in-process |

Pre hooks can allow, deny, ask, modify input, or add context. Hook chains match
multi-event sequences and fire a configured action when their conditions pass.
The hook workbench can load, save, reload, scaffold, simulate, inspect, import,
and export managed hook config.

## Workflow triggers

Workflow triggers evaluate hook events and run configured actions when
conditions match. Conditions support field-path lookup, comparisons, boolean
logic, and event-derived values. Actions can dispatch shell work or agent work
depending on the registered trigger definition.

## Runtime store and state

Runtime state is split between transient event/state managers and durable
stores. The runtime subtree includes:

- auth state
- compaction strategies
- diagnostics panels
- ecosystem catalog state
- event bus and emitters
- capability gates (feature settings)
- health checks
- idempotency
- integration status
- MCP runtime state
- notifications
- provider accounts and health
- remote runners
- retention policies
- sandbox state
- settings
- task adapters
- telemetry
- tool budgets
- transports
- worktree state

The state subsystem supplies SQLite/KV stores, file state cache, file undo,
file watcher, project index, memory vector store, mode manager, and telemetry
recorder.

## Profiles, bookmarks, and export

Profiles hold named display, provider/model, and behavior overrides that can be
switched per session. Bookmarks are named save-points inside sessions for quick
navigation and branching. Export renderers produce JSON, Markdown, and HTML
session exports with optional sensitive-data redaction.

## Code intelligence

The intelligence layer provides language detection, tree-sitter parsing, LSP
diagnostics, symbol extraction, outline parsing, and hover support. It degrades
when a backend is unavailable and is used by tools, analysis flows, and shell/
code-aware runtime features.

## ACP and remote runners

ACP manages agent communication protocol envelopes, handshake state,
connections, and manager lifecycle. Remote runtime support covers runner pools,
assignment, contracts, artifacts, review, and artifact import. The companion
surface can use daemon-hosted remote sessions without mutating shared TUI
provider/model state.
