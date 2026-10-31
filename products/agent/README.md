# GoodVibes Agent

## Jev migration status

Agent is a private workspace in the GoodVibes Jev monorepo, included in the
suite installer and root build, typecheck and test commands. Integration and
full product acceptance remain in progress. The upstream tour below describes
inherited behavior; the [current decision contract](../../docs/design/autonomous-jev-decisions.md)
supersedes its semantic confirmation/escalation paths. Explicit owner settings,
identity, scopes and revocation still control access. The shared judgment port
owns retry/waiting and cancellation.

## Install

Use the [suite installation guide](../../docs/installation.md) from the monorepo
root, then run `goodvibes-agent`. A fresh Agent home opens setup. The installer
pairs the TUI; Agent's connected-host credentials and native authority require
separate setup. See [native readiness](docs/setup-native-readiness.md) before
using native conversation or work controls. Completing the onboarding marker
alone does not grant those scopes.

This workspace is not installed through the upstream npm package. Updates use
the repository's `./install.sh`; the release and automatic-update descriptions
in historical product docs are not release claims for this checkout.

## Native work controls (local Jev implementation)

`/work` discovers the authenticated daemon's native project without legacy
planning lookup; `/work <daemon-project-id>` selects it explicitly.
`/work start|status|cancel|resume <work-id>` operates an existing native work
item. Commands derive attempt identity and revisions from the live ledger.

Start/resume require an existing active attempt and the daemon's current paired
operator authority. Execution controls do not create work or edit original criteria. Explicit source
submission is described below; ordinary text uses the native intake described next. Opening a view never starts or resumes
execution. Status/cancel retain the last observed attempt across a handoff within
that view; older attempts cannot be rediscovered after reopening this surface.

Reported work state, verified evidence, execution progress, admitted/current
revisions and recovery state remain distinct. A lost response leaves the server
outcome unknown. Closing or replacing host, token or workspace only aborts local
requests and discards their results; use Cancel to request host cancellation.
Pending and refused admissions, and cancellation before admission, have no
execution receipt or progress. They display requested revisions, separately from
admitted executions. Refused/interrupted admission recovery requires explicit
resume; a cancelled intent requires a new native attempt.
No control asks for owner approval or automatically retries/resumes execution.

## Ordinary conversation and first-start prerequisites

Ordinary owner text passes through the selected daemon's original-source intake
before any model receives it. With hosted routing enabled, conversational
results use identity-only native hosted delivery and later inputs retain the
same daemon-owned conversation. This requires an already paired operator,
`read:work-ledger`, `write:work-ledger` and `write:sessions`, a registered host
workspace, and Jev. Turning hosted routing off selects the local native permit
path. Neither path uses a second legacy classification or source-less work
start. Missing authority, unsupported attachments or an unknown dispatch
produce a visible diagnostic; there is no legacy conversation fallback.

The exact original and delivery mode survive restart. `/work intake-status`
inspects and reopens observation; `intake-retry`, `intake-resume` and
`intake-cancel` recover or cancel that same original. A lost reply never creates
fresh IDs or switches delivery modes. [Remote-owner contract](../../docs/design/agent-native-remote-conversation.md).

Pairing remains explicit setup. The existing `pairing.tokens.migrate` operator
method accepts `{ "name": "Agent" }` from an authenticated existing shared-token
operator with `write:control-plane`, and returns a per-device token once. The
new token must then be configured for Agent's selected host. Agent's current
confirmed local-token provisioning route only prepares the legacy shared token;
it does not perform that migration or install the returned paired token. Fresh
onboarding into native authority remains an unresolved integration step. Merely
opening Agent, finishing its onboarding marker, or answering the first-start
checkpoint question does not grant that authority.

## Explicit native source submission

Both products use the same command contract:

- `/work submit-file <path>` reads a regular UTF-8 JSON file containing exactly
  `goal` (a string) and `criteria` (an ordered array of strings).
- `/work submission-status` looks up the retained request without writing work.
- `/work submission-retry` first looks up that same request. Only a `not-found`
  result can lead to replay of the exact retained request.

Example source file:

```json
{"goal":"  Deliver the original goal\nwithout rewriting it  ","criteria":["First criterion","Second criterion","First criterion"]}
```

Decoded goal/criterion strings are preserved verbatim, including whitespace,
line breaks, order and duplicates. No model generates or changes criteria.
Blank/whitespace-only values and missing criteria are rejected locally. Each
string is limited to 20,000 UTF-16 code units; 1–100 criteria are required. Both
the source file and complete encoded submission must fit 262,144 UTF-8 bytes.
For paths containing spaces, use a file URL such as
`file:///tmp/my%20source.json`, which survives both slash-command parsers.

Initial submission generates request/input IDs and captures the live whole-ledger
revision once. Before sending, the app durably publishes the exact source, IDs and
revision in its private `native-work-submission.json` journal under its product
state directory. The journal binds each request to the exact daemon endpoint,
canonical workspace, project and live server-verified paired principal. It stores
no bearer token. The journal has at most 16 bindings and 2 MiB; corrupt, oversized,
symlink-backed or unconfirmable state fails closed without a submission.

After a restart, use `submission-status` or `submission-retry` to recover the
original request. Both first look it up using that same identity. Retry does not
reread the source file, generate new IDs or refresh the revision. Only an explicit
retry after `not-found` can send the identical durably confirmed request. A
`not-found` lookup is not proof that a lost in-flight request cannot still arrive.
A persistence failure sends nothing and retains any uncertain journal publication
for inspection/recovery; it never deletes or silently replaces that identity.
Changing credentials to another principal cannot replay the old principal's
journal. Host, token, project and canonical-workspace changes or cleanup discard
in-flight results; overlapping submission commands remain single-flight.

A definite stale-ledger conflict permits an explicitly new `submit-file` command
to capture a new identity/revision. An unresolved retained request must be looked
up before submitting a new source. Submission/replay never starts execution.

Submission requires an existing paired operator with native ledger read/write
scopes. It never grants scopes, stores credentials or starts execution. The
receipt identifies the created work/current attempt and preserves the original
source; inspect `/work` and use its separate explicit Start control.

## Upstream product reference

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

GoodVibes Agent is an installable autonomous operator assistant. You run `goodvibes-agent` and get one workspace for chat, planning, memory, research, scheduling, and confirmation-gated automation, backed by a connected GoodVibes host that supplies the operator API, schedules, channels, knowledge, media, and remote-execution routes. Agent presents that capability as a user-first harness, with route planning, plain-language confirmations, and redacted receipts for anything it sends, spends, or writes, instead of exposing raw daemon plumbing. It can also reuse provider, permission, and other shared settings already configured for goodvibes-tui or another published GoodVibes platform store, so setup does not start from zero.

<img src="docs/assets/operator-workspace.png" alt="The fullscreen GoodVibes Agent operator workspace. A left column lists operator areas under an Onboarding heading, with Start and Models flagged for attention. The right pane is headed Start, 16 actions, and summarises setup state: 3 of 13 done, 4 need attention, the current chat route, a count of local personas, skills, routines, and memories, and a next step reading Connected-host auth, blocked. Below, a Setting / Default / Current table lists the available actions: use a local model with no sign-in, sign in to a provider, choose main model, import GoodVibes settings, reasoning effort medium, save history true, and a Finish setup row. A footer shows the workspace key hints." width="900">

---

## A short tour

**The workspace is the product.** `goodvibes-agent` opens straight into a fullscreen operator workspace (reopen it any time with `/agent`, `/home`, or `/operator`); slash commands and CLI subcommands are power-user and scriptable mirrors of the same actions. Press `/` inside the workspace to search every action by name, category, command, or detail.

**One assistant, several jobs.** Beyond normal chat, the workspace gives you read-only web research with explicit hand-off into Agent Knowledge, versioned document drafting with blind model comparison, a Personal Ops area for inbox/agenda/task/reminder/note requests, and an Operator Runtime view of the connected host's own methods and service posture.

<img src="docs/assets/chat.png" alt="A chat turn in the Agent workspace. The header carries the user's question, what can you help me do on this machine. The answer renders as markdown with numbered sections: File and Work Management, Research and Discovery, Agent Configuration, and Personal Operations, each with a short bulleted list, followed by three clarifying questions and a closing suggestion to inspect current status before making changes. A Recent panel on the right lists three timestamped activity entries. The footer shows the active route openrouter:openrouter/free, context at 17 percent, and the turn's up and down token counts." width="900">

**Local behavior is yours to shape.** A friendly `VIBE.md` personality file, separate from project instruction files (`AGENTS.md`, `CLAUDE.md`, and similar), plus local memory, notes, personas, and skills all live under the Agent home and are scanned for secret-looking content before they ever reach a prompt. Personas capture a reusable voice or role; skills capture a reusable capability; routines capture a reusable sequence you can start in chat and, as a separate explicit and confirmation-gated step, promote to a connected schedule.

**Automation stays visible and confirmed.** Reminders, schedules, channel sends, media generation, and visible background agents all show up in one autonomy queue, and every one of them requires an explicit user request plus confirmation before anything actually sends, spends, or runs unattended.

**The model can plan its own route.** Ask a plain question like "email the team a summary" or "what's blocked in setup" and the underlying model can call a route planner that maps the request to the right tool and confirmation boundary before doing anything. It does not have to guess at internal tool names, and ambiguous requests come back as candidates instead of a wrong guess.

<img src="docs/assets/model-picker.png" alt="The Model Workspace, headed Providers And Models. A left column lists the routing targets: Main Chat set, Helper Model off, Tool LLM off, and TTS LLM inherit. The right pane shows the selected target with its current route, the highlighted model and its context window and capabilities, and a filter row for search, price, capability, grouping, and availability. Below, a table of 1906 catalogued models lists model key, display name, provider, context window, tier, and capability flags, with a row indicating 1883 more models below and a footer of list shortcuts including search, price, capabilities, availability, benchmark, and grouping." width="900">

**Isolated by design.** Agent Knowledge is its own segment. Agent only talks to `/api/goodvibes-agent/knowledge/*` and never falls back to another product's knowledge store. Named Agent profiles (`goodvibes-agent profiles create ...`) give you separate, isolated config, sessions, memory, and personas per household, project, or role.

---

## What's in the box

Each row links to the page that documents it. The workspace's own `/` search and `/help` are always the current authority.

| Area | What you get | Docs |
| --- | --- | --- |
| Getting started | Requirements, install paths, first-run areas, model-visible route table, isolated profiles | [getting-started.md](docs/getting-started.md) |
| Connected host | The one required daemon dependency, its knowledge routes, override env vars, product-boundary rules | [connected-host.md](docs/connected-host.md) |
| Providers and routing | Provider/model visibility, local provider definitions, the local model cookbook | [providers-and-routing.md](docs/providers-and-routing.md) |
| Tools and commands | Workspace actions, slash commands, CLI mirrors, model-tool catalog, settings and keybinding writes | [tools-and-commands.md](docs/tools-and-commands.md) |
| Knowledge, artifacts, and multimodal | Isolated Agent Knowledge, document/image/media artifacts, ingest and review routes | [knowledge-artifacts-and-multimodal.md](docs/knowledge-artifacts-and-multimodal.md) |
| Channels, remote access, and API | Slack, Discord, Telegram, Matrix, webhook, and other configured channels; setup/triage/delivery; companion pairing; the operator method catalog | [channels-remote-and-api.md](docs/channels-remote-and-api.md) |
| Voice and live TTS | Spoken playback, TTS/STT provider setup | [voice-and-live-tts.md](docs/voice-and-live-tts.md) |
| Release and publishing | Package identity, release asset layout, the package gate | [release-and-publishing.md](docs/release-and-publishing.md) |
| Testing and validation | What runs locally, on every push, before a release, and at the version bump | [testing-and-validation.md](docs/testing-and-validation.md) |
| Google setup | The generated step-by-step runbook for connecting Gmail and Google Calendar, plus which OAuth scopes the integration requests and why | [google-setup-runbook.md](docs/google-setup-runbook.md), [google-scope-strategy.md](docs/google-scope-strategy.md) |

Full index: [docs/README.md](docs/README.md).

---

## Configuration

Settings live in a layered `settings.json`, editable through the `/settings` workspace or by hand:

- global: `~/.goodvibes/agent/settings.json`
- project: `.goodvibes/agent/settings.json`

A few keys worth knowing up front:

| Key | Default | What it does |
| --- | --- | --- |
| `update.autoUpdateAtLaunch` | `true` | Check for and install a newer release at launch (standalone binaries only) |
| `update.launchCheckTimeoutMs` | `2500` | How long that launch check may take before it is skipped; clamped to 250–30000 |
| `update.auto` | follows `update.autoUpdateAtLaunch` | Keep checking WHILE the agent runs, and install at an idle moment (standalone binaries only); an explicit value always wins over the inherited one |
| `update.intervalMinutes` | `60` | Minutes between those periodic checks; clamped to 5–1440 |
| `update.firstCheckSeconds` | `30` | Seconds after start before the first periodic check; clamped to 0–3600 |
| `checkpoints.preferGitRoot` | `true` | Snapshot the enclosing git repository's root rather than the raw working directory |
| `checkpoints.allowBroadRoot` | `false` | Opt in to snapshotting a broad root such as the filesystem root or home directory |
| `checkpoints.autoRetention` | `true` | Run a retention sweep automatically after each checkpoint |

Other useful overrides:

- `GOODVIBES_AGENT_HOME=/path/to/agent-home`: run with an isolated Agent home instead of the default one.
- `GOODVIBES_AGENT_RUNTIME_URL=http://host:port` (or the `--runtime-url` flag): point at a GoodVibes host on a different address; `GOODVIBES_AGENT_BASE_URL` is accepted as a legacy alias.
- `~/.goodvibes/agent/providers/*.json`: local, hot-reloaded custom provider definitions.
- `/settings action:"import"` (or `import_goodvibes_settings`): preview, then apply, provider/UI/permission/subscription/surface/tool/daemon-endpoint settings already configured for goodvibes-tui or another published GoodVibes platform store, without mutating the source.

The full settings catalog, the checkpoint-guard keys, and the shared-settings-import contract are in [docs/tools-and-commands.md](docs/tools-and-commands.md) and [docs/getting-started.md](docs/getting-started.md).

---

## Development

Agent builds on the existing terminal renderer and workspace foundations of the GoodVibes platform; what differs is the product layer composed on top of them.

```sh
git clone https://github.com/mgd34msu/goodvibes-jev.git
cd goodvibes-jev
bun install
bun run build
bun run --cwd products/agent dev
```

Run these commands from `products/agent` after preparing the monorepo:

| Command | Does |
| --- | --- |
| `bun run dev` | Run the Agent TUI from source |
| `bun run test` | Run the full test suite through the deterministic suite runner |
| `bun run typecheck` | Type-check the source tree |
| `bun run build` | Bundle the workspace package entrypoint into `dist/package/main.js` |
| `bun run build:binary` | Compile the native Agent executable and stage its sqlite-vec library in `dist/lib` |

Source layout, in brief:

```text
src/
├── main.ts, core/       terminal entrypoint, orchestrator
├── agent/               channel, calendar, document, and automation domain logic
├── tools/               agent-owned model tools (harness, workspace, channels, knowledge, work plans, ...)
├── permissions/         approval posture and confirmation prompts
├── input/               slash commands, workspace actions, command routing, MCP server management
├── renderer/            terminal UI
├── cli/, cli-flags.ts   CLI subcommands and flags, package verification
├── config/              settings, secrets, checkpoint and update policy
├── runtime/             update checks, release-artifact resolution
├── audio/               spoken-turn playback and routing
└── verification/        release-readiness and evidence checks
```

Tests live under `src/test/`, mirroring the source tree, and cover runtime contracts, security boundaries and workspace/tool/CLI behavior. Use the declared workspace scripts above or the root product checks; package publication commands from the upstream product are not part of this private workspace.

The Agent consumes `@goodvibes-jev/engine` and `@goodvibes-jev/daemon` through `workspace:*` dependencies for shared contracts, daemon routes, and transports, and keeps the workspace, local behavior library, and Agent Knowledge boundary here. GoodVibes Agent owns the autonomous assistant harness; the connected GoodVibes host owns the platform capabilities Agent presents.

---

## Stability

The product reference above describes inherited upstream behavior. The Jev migration status and current decision contract take precedence for this workspace; upstream changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
