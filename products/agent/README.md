# GoodVibes Agent

[![CI](https://github.com/mgd34msu/goodvibes-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/mgd34msu/goodvibes-agent/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-2.1.0-blue.svg)](https://github.com/mgd34msu/goodvibes-agent)

GoodVibes Agent is an installable autonomous operator assistant. You run `goodvibes-agent` and get one workspace for chat, planning, memory, research, scheduling, and confirmation-gated automation, backed by a connected GoodVibes host that supplies the operator API, schedules, channels, knowledge, media, and remote-execution routes. Agent presents that capability as a user-first harness, with route planning, plain-language confirmations, and redacted receipts for anything it sends, spends, or writes, instead of exposing raw daemon plumbing. It can also reuse provider, permission, and other shared settings already configured for goodvibes-tui or another published GoodVibes platform store, so setup does not start from zero.

<img src="docs/assets/operator-workspace.png" alt="The fullscreen GoodVibes Agent operator workspace. A left column lists operator areas under an Onboarding heading, with Start and Models flagged for attention. The right pane is headed Start, 16 actions, and summarises setup state: 3 of 13 done, 4 need attention, the current chat route, a count of local personas, skills, routines, and memories, and a next step reading Connected-host auth, blocked. Below, a Setting / Default / Current table lists the available actions: use a local model with no sign-in, sign in to a provider, choose main model, import GoodVibes settings, reasoning effort medium, save history true, and a Finish setup row. A footer shows the workspace key hints." width="900">

---

## Install

```sh
bun add -g @pellux/goodvibes-agent
bun pm trust -g goodvibes-daemon
goodvibes-agent --help
goodvibes-agent
```

The Agent talks to a GoodVibes daemon, so this package depends on `goodvibes-daemon` and one install brings both commands. Bun blocks lifecycle scripts for untrusted global packages, and the daemon's own postinstall is what places the daemon binary, hence the trust line. Nothing else here needs trusting; this package has no postinstall of its own. Check both landed with `goodvibes-agent --version` and `goodvibes-daemon --version`; they report different numbers because they are separate products on separate version lines.

If `goodvibes-agent` is not on `PATH` after a global install:

```sh
export PATH="$(bun pm bin -g):$PATH"
```

On a fresh Agent home, `goodvibes-agent` opens setup first; once setup is applied it opens directly into the Agent workspace.

Each GitHub release also attaches standalone compiled binaries and a `SHA256SUMS.txt` manifest, for environments that download a binary directly rather than through Bun:

| Release asset | Platform |
| --- | --- |
| `goodvibes-agent-linux-x64` | Linux on x86-64 |
| `goodvibes-agent-linux-arm64` | Linux on ARM64 |
| `goodvibes-agent-macos-x64` | macOS on Intel |
| `goodvibes-agent-macos-arm64` | macOS on Apple silicon |
| `sqlite-vec-<os>-<arch>.tar.gz` | Per-platform semantic-index addon archives, one per binary above |
| `SHA256SUMS.txt` | Checksums for every asset; the updater verifies downloads against it |

A directly-downloaded binary self-updates at launch. It runs a bounded check against the latest GitHub release, then a checksum-verified download-and-swap when one is newer, and every swap keeps the replaced file beside it as `<file>.previous` so `/update rollback` can undo it. Package-managed installs never self-swap; they defer to `bun add -g` instead. `update.autoUpdateAtLaunch: false` in `settings.json` turns the launch check off.

A long-running agent also keeps looking after launch. The same checksum-verified path runs on a periodic check (first one ~30s after start, hourly after that) and installs only at an idle moment, meaning no active turn, no in-flight channel delivery, and no confirmation waiting on you. It then restarts in place with the same arguments. `update.auto: false` turns that off.

The semantic (embedding-backed) memory index depends on a native `sqlite-vec` addon that Bun cannot embed in a compiled binary, so each release ships it separately as `sqlite-vec-<os>-<arch>.tar.gz`. A binary with no co-located addon still runs; memory search falls back to literal matching until the matching archive is extracted next to it. This addon stays unavailable on macOS regardless of co-location, because the system SQLite that macOS links refuses to load extensions.

Connect Agent to a GoodVibes daemon before using daemon-backed features. The default target is `http://127.0.0.1:3421`. `goodvibes-agent status --json`, `goodvibes-agent doctor`, and `goodvibes-agent compat` are scriptable checks for that connection and for the install itself. Deeper install notes, the full workspace tour, and CLI diagnostics are in [docs/getting-started.md](docs/getting-started.md) and [docs/connected-host.md](docs/connected-host.md).

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
git clone https://github.com/mgd34msu/goodvibes-agent.git
cd goodvibes-agent
bun install
bun run dev
```

| Command | Does |
| --- | --- |
| `bun run dev` | Run the Agent TUI from source |
| `bun run test` | Run the full test suite through the deterministic suite runner |
| `bun run typecheck` | Type-check the source tree |
| `bun run build` | Compile `src/main.ts` into `dist/goodvibes-agent` |
| `bun run package:install-check` | Verify the packaged CLI actually installs and runs |
| `bun run publish:check` | Run the package-facing text, metadata, and tarball-contents gates |

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

Tests live under `src/test/`, mirroring the source tree, and cover contracts, release gates, package-facing text policy, security boundaries, and the workspace/tool/CLI surfaces above. `bun run publish:check` and `bun run package:install-check` are the same gates the release pipeline runs before a version is published.

The Agent consumes the bundled GoodVibes platform runtime, pinned in `package.json`, for shared contracts, daemon routes, and transports, and keeps the workspace, local behavior library, and Agent Knowledge boundary here. GoodVibes Agent owns the autonomous assistant harness; the connected GoodVibes host owns the platform capabilities Agent presents.

---

## Stability

Documentation always describes the **current** behavior, not historical behavior. Notable changes are recorded in [CHANGELOG.md](CHANGELOG.md).

## License

MIT
