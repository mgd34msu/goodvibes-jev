# Tools and commands

GoodVibes Agent is a TUI-first operator assistant. The workspace is the primary user surface; slash commands are power-user routes inside the TUI; CLI subcommands are scriptable mirrors.

## Boundaries

- Normal chat stays in the main Agent conversation.
- Agent Knowledge uses only `/api/goodvibes-agent/knowledge/*`.
- Agent does not query default knowledge or other product knowledge spaces.
- Connected-host lifecycle is external. Agent reports and uses public routes, but does not start, stop, restart, install, expose, or mutate the host listener.
- Local read/edit/exec is available for explicit work in the current Agent workspace when permissions are sufficient. `execution action:"status|route"` exposes process monitor, live tail, tool inspector, browser/desktop ready-attention-setup state, workflow cards, setup checklists, fallback routes, sudo posture, tracked process routes, and delegation decision cards for local work.
- `execution action:"history|record|processes|process|recovery"` gives direct read-only access to activity cards, exact records, tracked local processes, bounded redacted output, and file edit recovery.
- First-class `terminal` and `process` adapters expose the expected `terminal(command, background:true)` and `process(action:"list|poll|wait|log|kill|write")` UX over the same tracked ProcessManager lifecycle.
- Lower-level `execution_posture`, `execution_route`, `background_processes`, `background_process`, `run_background_process`, `execution_history`, `execution_history_item`, `file_recovery`, and `run_file_recovery` modes remain available for detailed compatibility inspection and confirmed recovery/lifecycle effects.
- Visible Agent subagents stay serial-by-default unless parallelism helps the user. `agent_orchestration` and `agent_orchestration_agent` expose live Agent state, managed multi-agent plan cards, work-plan links, dispatch receipts, closeout review cards, remote-runner evidence, certified daemon/SDK live remote capture/export/closeout outcome records, and certified workspace/worktree isolation evidence with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata and missing-signal surfacing.
- The same orchestration modes carry auto-attached remote artifact review routes, spawn/batch-spawn policy, and safe first-class `agent` control routes, while confirmed `agent_work_plan action:"dispatch_agents"` converts approved plan items into visible agent jobs with saved receipts.
- Delegation is for isolation, parallelism, remote execution, separate worktrees, or user-requested delegated review; `delegation action:"status|routes|route"` exposes local-first, TUI handoff, delegated-review, remote-inspection, and hidden-fanout-blocked lanes with required fields, success evidence, status routes, and recovery routes.
- External delivery, notifications, reminders, media generation, setting writes, keybinding writes, UI routing, slash-command execution, workspace-action execution, local destructive changes, and connected-host operator actions require explicit user request and confirmation.
- Autonomous scheduled work uses the first-class `schedule` adapter, `schedule action:"list|create|remind|edit|run|pause|resume|delete"`. Creation still requires an explicit task or reminder, cadence, success criteria for autonomous work, user request provenance, and confirmation.

## User-facing surfaces

High-signal TUI routes:

| Surface | Purpose |
| --- | --- |
| `/agent` | Open the fullscreen operator workspace. |
| `/help` and `/commands` | Discover registered slash commands. |
| `/health`, `/compat`, `/auth` | Inspect runtime, connected-host, compatibility, and auth posture. |
| `/model`, `/provider`, `/effort` | Inspect or change provider/model/reasoning routes. |
| `/knowledge` | Use isolated Agent Knowledge. |
| `/vibe`, `/memory`, `/notes`, `/personas`, `/skills`, `/routines` | Manage VIBE.md personality and Agent-local behavior libraries. |
| `/approval`, `/automation`, `/schedule` | Read posture and run exact confirmed operator actions. |
| `/channels`, `/notify`, `/qrcode` | Pair companions, inspect channel readiness, review delivery receipts, and send confirmed messages. |
| `/media`, `/voice`, `/tts` | Inspect media/voice readiness, generate media, and run spoken turns. |
| `/mcp`, `/secrets`, `/settings`, `/config` | Inspect or update Agent-local configuration. |
| `/delegate` | Hand explicit build/fix/review work to GoodVibes TUI with a confirmed handoff brief. |

An agent or a background process can take over the whole terminal. `Enter` on an agent's lane in the work tree (or on its row in the Activity modal) opens the agent: its work is the spine, its own children branch off it, the header reads `main › researcher` in the agent's color, and the composer steers the agent while main keeps running. `Enter` on a `▶` bead (or a row in the process monitor) opens the process: live output with timestamps, errors in red, follow mode on. The process view takes no input, because the Agent cannot write to a background process's stdin; `/` searches its output and `y` copies it. While more than one session exists, a row of session chips under the header lists them, and `Tab` / `Shift+Tab` switch between them when the composer is empty.

`Esc` in a view goes back up one level (a child agent returns to the agent that started it, then main) and never stops anything. Stopping is `Ctrl+X`: the first press asks, the second stops. The status line always says what the next `Esc` does.

## Model tools

| Tool | Use |
| --- | --- |
| `route` | Pick the best visible Agent route for a plain user task without executing tools or creating hidden work. |
| `agent` | Spawn, batch-spawn, inspect, message, wait, cancel, and report visible Agent subagents. |
| `agent_harness` | Discover and operate Agent harness routes, including visible surfaces and operator/audit inspection. |
| `agent_knowledge` | Read isolated Agent Knowledge: status, ask/search, lists, item, map, connectors. |
| `agent_knowledge_ingest` | Confirmed URL, file, artifact-id, browser, bookmark, or connector ingest into isolated Agent Knowledge. |
| `agent_learning_consolidation` | Preview, apply, rollback, or exact-id recreate one confirmed Agent-local duplicate-consolidation phase with receipts. |
| `agent_local_registry` | Inspect or update Agent-local memory, notes, personas, skills, bundles, and routines. |
| `agent_work_plan` | Keep the visible Agent-local work plan current and dispatch approved plan items to visible agents with confirmation and receipts. |
| `agent_operator_briefing` | Read connected work, approvals, automation, schedules, and capacity posture. |
| `schedule` | List, create, edit, run, pause, resume, and delete connected schedules through existing confirmation gates. |
| `setup` | Inspect first-run setup, choose the next safe setup repair route, show one setup row, inspect/save/clear checkpoints, repair token auth, run setup smoke, finish onboarding, and import GoodVibes settings through existing gates. |
| `security` | Read security posture/findings and explain why one model action is allowed, denied, or needs confirmation. |
| `vibe` | Inspect VIBE.md status/show, create project/global VIBE.md, or import VIBE.md as an Agent-local persona through existing gates. |
| `browser` | Drive a real web browser: open pages, take an element snapshot, click, type, select, scroll, wait, read the page text, extract data by selector or ref, screenshot, and manage tabs. Provisions its own browser on first use and keeps sign-ins in a saved profile. It runs no caller-supplied script in a page: `extract` names the fields it wants, so a page cannot be made to transmit anything. |
| `computer` | Inspect browser/PWA readiness, plan browser/screenshot/desktop-control workflows, inspect MCP/setup posture, and open the browser cockpit through confirmation-gated visible routes. |
| `device` | Inspect device capability, companion/mobile, voice/media, and provider posture; open TTS pickers through confirmation-gated visible routes. Browser/PWA and desktop-control compatibility routes remain available, but `computer` is the primary route. |
| `import_goodvibes_settings` | Preview or apply shared GoodVibes settings import through the existing redacted import plan and confirmation gate, including source-package ownership metadata. |
| `agent_operator_action` | Run exact confirmed approval/automation/schedule actions. |
| `agent_schedule_edit` | Edit one confirmed connected schedule by id. |
| `agent_documents` | Create, revise, review, comment on, suggest changes to, list, show, attach saved artifacts to, insert saved artifacts into, and export project-scoped drafts with reviewer appendices. |
| `agent_review_packet_presets` | Save, list, show, freshness-check, and refresh reusable Document Ops review packet presets without changing drafts, routes, handoffs, archives, or source presets. |
| `agent_review_packet_share` | Share one confirmed reviewer handoff archive reference through a configured channel target without printing or attaching ZIP bytes. |
| `agent_artifacts` | Browse, preview, export, package, and archive saved Agent artifacts. |
| `agent_research_runs` | Create, checkpoint, pause, resume, cancel, complete, fail, list, and show log tails for project-local visible research run records. |
| `agent_research_sources` | Capture, review, reject, mark used, list, and bundle project-local research source queue records. |
| `agent_research_report` | Save one confirmed sourced research report artifact with source map, citation coverage metadata, repair hints, and optional visual report packet sections. |
| `research` | Plan research, inspect runs/sources, bundle reviewed sources, and perform confirmed run/source/report actions through one user-facing route. |
| `agent_channel_send` | Send one confirmed channel message and return a receipt id when receipt storage is available. |
| `agent_notify` | Send one confirmed notification through configured webhook targets. |
| `agent_autonomy_schedule` | Create one confirmed visible autonomous Agent schedule. |
| `agent_reminder_schedule` | Create one confirmed connected reminder/schedule. |
| `agent_media_generate` | Generate one confirmed image/video artifact. |
| `agent_model_compare` | Run, review, side-by-side view, handoffDiff with section jumps, judge, routeDecision receipts, task/document/benchmark-filtered analytics/synthesis, apply, export, handoff, handoffArchive, or reveal one blind model comparison, optionally from a saved text artifact. |
| `agent_operator_method` | Run one exact public daemon method. Read-only methods run directly; write/admin methods require `confirm:true` plus `explicitUserRequest`. |
| `accounts` | List, alias, record, forget, and sweep the register of accounts created for the owner. |
| `audit` | Read operator/audit release readiness, evidence, single inventory items, and release artifacts. |
| `autonomy` | Turn an ongoing-work request into the safest visible route and inspect the visible autonomy queue and its cards. |
| `capability_status` | Report what this build can do, read from its live runtime state, before answering capability questions from memory. |
| `channels` | Inspect channel readiness, one channel, the ordered setup guide, channel triage, and redacted delivery receipts. |
| `context` | Inspect secret-scanned project context files and the applied prompt composition, receipts, and token budget. |
| `delegation` | Inspect delegation posture and routes for isolation, parallelism, remote execution, separate worktrees, and delegated review. |
| `execution` | Inspect local-vs-delegated execution posture, tracked processes, PTY/stdin/sudo capability, activity history, and file edit recovery. |
| `google` | Connect the owner's Google account, then read and send Gmail and read and write Google Calendar through the granted scopes. |
| `host` | Inspect connected-host status, the capability map, service endpoint posture, and the public daemon method catalog. |
| `memory` | Inspect Agent-local memory posture, external memory providers, and the learning curator; confirmed record create/update/review/stale/delete forwards to the local registry's gates. |
| `models` | Inspect provider/model route readiness, provider posture, and the local model cookbook; run confirmed local server smoke checks. |
| `occasions` | Raise occasions and trips, answer yes/no/later, run the gift interview, and capture occasion facts. |
| `personal_ops` | Read the daily briefing, saved review queue, connector readiness, and request intake; run one confirmed read-only inbox/calendar read. |
| `process` | List, poll, read bounded logs from, wait on, stop, and write to tracked background processes through confirmation gates. |
| `profile` | Read and record what GoodVibes knows about the owner, field by field, with provenance. |
| `sessions` | List, search, and inspect saved sessions and bookmark posture. |
| `settings` | List, get, set, and reset Agent settings; preview and apply shared GoodVibes settings import. |
| `support` | Read redacted support bundle posture and bundle routes. |
| `terminal` | Start one tracked background command (`background:true` is required; foreground work uses `exec`) through the shared ProcessManager lifecycle. |
| `workspace` | Discover and run workspace actions, slash commands, CLI mirrors, UI surfaces, and keybindings through existing gates. |

## `agent_harness`

Use `route action:"plan" query:"..."` first when a plain user task could map to several GoodVibes surfaces. It returns the preferred visible route, alternatives, missing fields, confirmation boundary, workspace matches, and harness mode matches without running tools.

Routing wording maps to these surfaces before any mutation or live effect:

- Host/daemon health, doctor, readiness, service, and compatibility diagnostics route to `host action:"status"` before any repair or service lifecycle effect.
- Normal settings/configuration requests route to `settings action:"list"` before any set/reset mutation.
- Model provider, local cookbook, local server smoke, and route-fit wording routes to `models action:"provider|local|smoke|route"` before credential, smoke, benchmark, or route-change effects.
- Personal Ops briefing, saved queue, fresh inbox/calendar read, and connector setup wording routes to `personal_ops action:"briefing|queue|intake|lane"` before live provider reads or effects.
- Direct reminder, schedule, cron, and schedule lifecycle requests route to `schedule action:"list"` before confirmed schedule effects; broader ongoing work stays on autonomy intake.
- Command-shaped background work routes to `execution action:"processes"` and the first-class `terminal`/`process` UX; interactive PTY/stdin/sudo wording routes to `execution action:"process_capabilities"` before any hidden process start or credential effect; scheduled or watcher-like background work stays on autonomy intake.
- External-memory provider, backend, cross-session sync, import/export, or named-provider wording routes to `memory action:"provider"` or the external provider checklist before any provider write, sync, credential, or import/export effect.
- Browser-backed research runner wording routes to `research action:"runner"` readiness, and visual research report rendering routes to `research action:"plan"` plus report artifacts before claiming browser/PWA rendering.
- Voice workflow and TTS-provider wording routes to `device action:"voice|provider"` before capture, playback, or picker effects.
- Browser cockpit/PWA wording routes to `computer action:"browser"` before confirmed visible browser handoff.
- Channel setup, triage, delivery receipts, and send requests route to `channels action:"setup|triage|deliveries|channel"` before confirmed external delivery.
- Permission posture, security finding, and blocked-action questions route to `security action:"status|finding|explain"`.
- Support-bundle requests route to `support action:"status|bundle"` before bundle export/import/share effects.
- Saved-session, bookmark, transcript, and continuity requests route to `sessions action:"list|search|get"` before session lifecycle effects.
- Release readiness, release evidence, verification ledger, and operator/audit requests route to `audit action:"readiness|evidence|item|artifact"`.
- File undo/redo/recovery requests route to `execution action:"recovery"` before any snapshot is applied.
- Media generation requests route to media provider readiness and confirmed `agent_media_generate` saved artifacts.
- Requests to open, read, or act on a web page route to the `browser` tool.
- Screen-observation and desktop-control requests, and browser/PWA readiness questions, still route to `computer action:"plan"` before live UI tools are considered.

Use `setup action:"repair"` first when the user asks to fix setup or the connected host; it chooses the next safe token repair, status, services.status receipt, user-run bootstrap, or no-action route without executing it.

Use `agent_harness mode:"summary"` for the broader cockpit. It starts with an assistant cockpit for setup, chat/model, project work, Personal Ops, research/docs, background work, and safety/recovery before implementation counters. Use `mode:"modes"` to search every harness mode by task, family, effect type, id, alias, or parameter name. Use `mode:"mode"` to inspect one mode contract.

Summary and plural catalog modes are compact by default. They return counts, ids, labels, state, effect class, and short `modelRoute` or `modelAccess` hints when a route decision is needed. Use `includeParameters:true` or a singular inspect mode when the model needs full schemas, policy detail, editor fields, redacted log tail, release artifact data, route hints, or tool parameters.

Discovery modes:

| Mode | What It Lists |
| --- | --- |
| `summary` | Assistant cockpit lanes, compact counts, status, and drill-in guide. |
| `modes` | Searchable catalog of every `agent_harness` mode and its task fit. |
| `route action:"plan"` plus lower-level `route_decision` | User-task route planning across Agent setup, Personal Ops, research runner/report workflows, autonomy, execution, delegation, computer/browser/PWA, workspace, host, device/voice/TTS, channel, security, support bundles, saved sessions/bookmarks, release/audit evidence, Local Context, external memory-provider setup, and Knowledge surfaces. |
| `workspace action:"status\|actions\|action"` plus lower-level `workspace`, `workspace_categories`, `workspace_actions` | Workspace categories and actions. |
| `workspace action:"commands\|command\|cli_commands\|cli_command"` plus lower-level `commands`, `cli_commands` | Slash commands and top-level package CLI mirrors with compact policy and route hints. |
| `workspace action:"surfaces\|surface"` plus lower-level `ui_surfaces` | Visible modal/overlay/picker/workspace surfaces. |
| `workspace action:"shortcuts\|keybindings\|keybinding"` plus lower-level `shortcuts`, `keybindings` | Fixed shortcuts and configurable keybindings with direct route/access metadata. |
| `settings` | Compact Agent setting rows with category, prefix, query, hidden, and limit filters. |
| `tools` | First-class model tool definitions with compact harness inspection routes; schema details require `includeParameters:true` or `tool`. |
| `channels action:"status\|channel\|setup\|triage\|deliveries"`, `notifications` | Channel readiness, ordered setup guide state, blockers/retry triage, redacted confirmed-send receipts, and redacted notification targets. |
| `context action:"files\|file"` | Secret-scanned `.hermes.md`, `HERMES.md`, `AGENTS.md`, `CLAUDE.md`, `HERMES_HOME/SOUL.md`, `.cursorrules`, and `.cursor/rules/*.mdc` files, including target-aware subdirectory context. |
| `context action:"prompt\|receipts\|receipt"` | Applied prompt composition order, recent durable receipt ids, exact receipt/turn/outcome filters, sanitized turn outcomes, selected context records, suppressed records, prompt previews on request, and approximate token budget; the same recent receipt outcomes are summarized in Agent Workspace -> Local Context with exact drill-in routes. |
| `memory action:"status\|provider\|curator\|candidate\|list\|search\|get"` plus lower-level `memory_posture`, `memory_provider` | Agent-local memory counts, prompt-active recall, vector stats, embedding-provider doctor warnings, provider inspection, curator review queues, direct memory record lookup/search, and external-memory setup contract maps for Honcho, OpenViking, Mem0, Hindsight, Holographic, RetainDB, ByteRover, Supermemory, and daemon-published similar backends, including provider-specific next routes, certified schema/version/publication/publisher/provenance checks, setup/status/read/write/sync/forget checks, required receipt fields, certified artifact evidence, and sanitized certified live read-model records when the SDK/daemon publishes them. |
| `agent_orchestration` | Live visible Agent records, managed multi-agent plan cards with milestones, work-plan links, dispatch receipt counts, closeout cards, remote-runner contract/artifact evidence, certified daemon/SDK live capture/export/closeout outcome records, certified workspace/worktree isolation evidence with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata and missing-signal surfacing, auto-attached remote artifact review routes, serial-by-default policy, approved work-plan dispatch route, spawn/batch-spawn decision cards, templates, and first-class `agent` routes for list/inspect/message/wait/cancel. |
| `models action:"status\|route\|local\|providers\|provider\|smoke"` plus lower-level `provider_accounts`, `model_routing`, `model_route`, `run_local_model_smoke` | Provider auth, provider/model route posture, visible route-readiness inspection, readiness scores backed by exact route-level provider-health records when published, hardware-scored local model cookbook with setup plans, exact local endpoint inspection, certified daemon-published local serving diagnostics with schema/provenance/publication and host-published start/repair routes when available, confirmed local model-list smoke checks, models-endpoint smoke criteria and refresh/provider-add hints, confirmed benchmark action/history/evidence review, and compatibility detail routes. |
| `execution action:"status\|route\|history\|record\|processes\|process_capabilities\|process\|recovery"`, `terminal`, `process`, plus lower-level execution harness modes | Local-vs-delegated execution routing, tracked process inspection, interactive PTY/stdin/sudo posture, direct process parity/doctor reports, first-class background-process start/manage adapters, process substrate probes with future stdin-write dispatch, grouped execution activity cards with redacted records, and file edit recovery. |
| `personal_ops action:"briefing\|status\|queue\|intake\|lane\|read"` plus lower-level `personal_ops_briefing`, `personal_ops`, `personal_ops_queue`, `personal_ops_intake`, `personal_ops_lane`, `run_personal_ops_read` | Read-only daily briefing plan across inbox, agenda, tasks, reminders, routines, delivery, notes, and autonomy queue; read-only saved inbox/calendar review queue with refresh routes, daemon/SDK provider read-model records, and follow-up boundaries; inbox/calendar connector readiness, request intake that chooses the safest lane/route/fields/confirmation boundary, classified MCP read/write tool hints, schema-derived operation records with fresh-read routes, triage/draft/agenda/conflict workflow cards, ordered connector-read/local-compose/confirmed-effect execution plans, confirmed read-only MCP inbox/calendar reads with bounded redacted output, normalized review cards, optional saved redacted review-card artifacts surfaced as redacted inbox thread/calendar event queue records with artifact inspect routes, freshness status, confirmed refresh routes when a matching read connector is ready, certified fresh provider-backed thread/event/task/reminder records with durable ids, labels, redacted snippets/notes, agenda windows, conflict signals, due times, cadence, delivery targets, source paths, schema/version/publication/publisher/provenance/receipt evidence, read-only inspect routes, local draft/reminder follow-up routes, certified provider-effect receipts for inbox/calendar/task/reminder outcomes, and confirmed provider-effect boundaries only when matching routes are published, matching MCP setup routes, and live Agent-owned note, routine, schedule-receipt, and delivery records. |
| `autonomy action:"intake\|queue\|item\|status"` | Ongoing-work route selection, visible autonomous work owners, schedule/watcher trigger posture, watcher receipt criteria, source-owned watcher evidence contracts, status, live task/approval/automation/schedule/watcher records, log tails, task/run diagnostics, host task and watcher output routes/previews, provider-source inspect/refresh controls, inspect routes, and normalized checkpoint/pause/resume/cancel/recovery controls. Lower-level `autonomy_intake`, `autonomy_queue`, and `autonomy_queue_item` modes remain available for detailed compatibility inspection. |
| `memory action:"curator\|candidate"` plus lower-level `learning_curator`, `learning_candidate` | Score-driven prompt plan, ranked local memory, note, persona, skill, bundle, routine, VIBE.md personality health, duplicate-consolidation batch review, completed-work, completed-research, and saved-session review/proposal candidates. |
| `document_ops`, `document_ops_lane` | Documents, review packet timeline, review packet wizard, packet presets/defaults/freshness, reviewer-readiness checks, uploads, exports, sources, artifact browse/promotion, media artifacts, and blind model comparison. |
| `mcp_servers`, `setup_posture`, `setup_repair`, `pairing_posture`, `delegation action:"status\|routes\|route"` | MCP, first-run setup wizard with direct `setup action:"status\|item\|repair\|checkpoint\|token\|smoke\|finish"` route hints, progress/current-step/checkpoint/backtracking routes, checkpoint auto-advance evidence, repeated-smoke-blocker focus, setup closeout decisions, read-only repair decisions for token/status/bootstrap/lifecycle/no-action routes, setup plan with probe-fed connected-host repair/auth cards, service lifecycle receipt gates, service repair success criteria, certified receipt outcomes, exact service lifecycle decisions, sudo execution posture, primary handoffs for actionable setup rows, confirmed local token provisioning, token-safe install smoke checks, confirmed setup smoke execution, saved redacted smoke evidence artifacts with history/trend surfacing, local model readiness with endpoint smoke-test follow-through, pairing/device capability posture, and build-delegation posture. Lower-level `delegation_posture` and `delegation_route` remain compatibility routes. |
| `security action:"status\|finding\|explain"` plus lower-level `security_posture`, `security_finding`, `policy_explain` | Redacted security posture, exact findings, and read-only policy explanations for allowed, denied, blocked, or confirmation-required model actions; route planning prefers status for active permission/approval questions, finding for incidents or leaked-secret records, and explain for one blocked or risky action. |
| `support action:"status\|bundle"`, `media_posture`, `sessions action:"list\|search\|get"` | Redacted support bundle posture, voice/media posture, and saved session/bookmark posture; lower-level support/session modes remain available for detailed compatibility inspection. |
| `host action:"status\|capabilities\|capability\|services\|service\|methods\|method"` | Connected-host status, capability map/detail, service endpoint posture/detail, and public daemon method catalog/detail. |
| `operator_methods`, `service_posture`, `connected_host`, `daemon` | Lower-level compatibility/detail routes for public operator methods, endpoint posture, connected-host posture, and daemon aliases. |
| `audit action:"readiness\|evidence\|item\|artifact"` | Operator/audit release artifacts and release-quality inventory; lower-level release evidence/readiness modes remain available for detailed compatibility inspection. |

Single-item inspect modes:

| Mode | Lookup Fields |
| --- | --- |
| `mode` | `target` or `query` |
| `workspace_action` | `actionId`, `command`, `target`, `query` |
| `command`, `cli_command` | `command`, `commandName`, `cliCommand`, `target`, `query` |
| `ui_surface`, `keybinding`, `tool` | Exact id/name or `target`/`query` |
| `channels action:"channel\|setup\|triage"`, `notification_target`, `provider_account`, `mcp_server` | Exact id or `target`/`query`; channel triage also accepts `limit` |
| `project_context_file` | `contextFileId`, `target`, or `query` |
| `agent_orchestration_agent` | `agentId`, `target`, or `query` |
| `setup_item`, `setup_repair`, `model_route`, `execution action:"route"`, `pairing_route`, `delegation action:"route"` | Exact id/model key or `target`/`query` |
| `setup_checkpoint` | Saved setup wizard checkpoint and current resume step, no lookup required |
| `personal_ops_briefing`, `personal_ops_queue`, `personal_ops_intake` | `query` or `target` |
| `personal_ops_lane`, `document_ops_lane` | `laneId`, `target`, or `query` |
| `memory action:"candidate"` or lower-level `learning_candidate` | `candidateId`, `target`, or `query` |
| `security action:"finding\|explain"`, lower-level `security_finding`, `policy_explain`, `support_bundle`, `media_provider`, `session` | Exact id/path/tool name or `target`/`query`; `policy_explain` also accepts `toolArgs` |
| `get_setting`, `service_endpoint`, `operator_method` | Exact key/id or `target`/`query` |
| `connected_host_capability` | `capabilityId`, `target`, `query` |
| `connected_host_status`, `daemon_status` | Live read-only status, no lookup required |
| `release_evidence_artifact`, `release_readiness_item` | `artifactId`/`itemId`, `target`, `query` |

Effect modes:

| Mode | Effect |
| --- | --- |
| `setup` tool | Preferred first-run setup route: `action:"status\|item\|repair\|checkpoint"` reads, including setup wizard closeout plus saved/artifact/live-read-model/ordered-event-stream receipt evidence; `action:"save_checkpoint\|clear_checkpoint\|token\|smoke\|finish\|import_settings"` delegates to existing confirmed setup effects. |
| `workspace action:"run"` | Executes one resolved workspace action through the same editor, command, or local route as the TUI; `actionId:"onboarding-apply-close"` is the confirmed setup closeout marker write. |
| `workspace action:"run_command"` | Executes one resolved slash command through the shared command registry. |
| `provision_connected_host_token` | Creates or repairs the local canonical connected-host token after confirmation without returning the raw token. |
| `mark_setup_checkpoint`, `clear_setup_checkpoint` | Saves or clears the Agent-owned setup wizard resume checkpoint after confirmation. |
| `run_setup_smoke` | Collects redacted first-run setup smoke evidence and can save user-run output as an artifact without implicit shell or host commands; `setup_posture` uses that evidence for setup closeout. |
| `workspace action:"open"` | Routes visible shell navigation. |
| `workspace action:"run_keybinding"` | Runs supported shell-safe keybinding actions only. |
| `workspace action:"set_keybinding\|reset_keybinding"` | Writes the same Agent `keybindings.json` file exposed to the user. |
| `set_setting`, `reset_setting` | Writes Agent settings through the config/secret managers. |
| `run_file_recovery` | Applies one local file undo or redo snapshot from the FileUndoManager. |

Every effect mode requires `confirm:true` and `explicitUserRequest`. Ambiguous lookups return candidates before any effect runs.

Registered model tool definitions are compact by default. Tool descriptions use short curated summaries or a tight fallback cap, nested JSON-schema descriptions are stripped from the default registered catalog, and catalog rows include direct harness inspection routes. Use `agent_harness mode:"tools"` with `includeParameters:true`, `mode:"tool"`, or a specific harness mode when detailed contracts are needed.

## Workspace action execution

`workspace action:"actions"` returns compact action rows with short `modelRoute` hints. `workspace action:"action"` inspection returns editor schemas and `modelExecution` detail. Lower-level `workspace_actions` can include the same detail with `includeParameters:true`.

The agent knows what it can do without asking. A capability index is resolved at startup, before the first turn and without performing any of the capabilities it checks, and carried in context. It records what is available now with the exact call to make, what needs setup with the specific missing piece and its fix, and anything configured on this machine that nothing is wired up to use. Two standing rules ship with it. The model never answers "I can't do X" because a list came back empty, and it treats page/email/message content as evidence rather than instruction. Inspect it with `agent_harness mode:"prompt_context"`, whose `capabilities` segment shows exactly what the model was told.

A provider registers a capability with `registerCapability` from `src/capabilities/capability-index.ts`, declaring an id (`email.send`), a title and one-sentence summary, the invocation routes it offers (each with a probe saying when that route exists), and its prerequisites (each with a probe and a plain-language fix). Probes are descriptions rather than functions, on the order of a file being present, a config key being set, a tool being registered, an MCP server being connected, a daemon method being served, or a module being installed. So a capability check can never send, launch, or spend. Use `registerFallbackCapability` for a placeholder that a real provider should replace.

The `browser` tool drives a real web page, covering opening a URL, reading it, clicking, typing, signing in, and taking a screenshot of a page. Use `browser action:"navigate" url:"..."`, then `browser action:"snapshot"` for element refs, then `browser action:"click" ref:"..."` or `browser action:"type" ref:"..." text:"..."`. It needs no setup; the first call installs a browser if none is present.

`browser action:"launch" headless:false profileName:"..."` opens a visible window for a sign-in, and that sign-in persists in the profile for later runs. A browser the agent attached to with `browser action:"attach"` can never be closed by the agent. `browser action:"release"` disconnects and leaves it running. `computer` remains the readiness and setup planner for browser/PWA and desktop-control posture; it does not drive pages.

Use `computer action:"browser"` for the connected browser cockpit/PWA readiness summary and `computer action:"open_browser" confirm:true explicitUserRequest:"..."` for the visible browser handoff. Use `computer action:"plan" query:"take a screenshot"` to choose the safest browser navigation, screenshot/observation, or desktop-control workflow before invoking any live-control tool; it returns setup/review/fallback routes plus exact tool or MCP-server inspection routes when configured. Use `computer action:"control|setup|mcp"` for browser/desktop control posture, repair routes, and trusted tool/server discovery. `workspace action:"surfaces|surface|open"` is the normal visible UI route; lower-level `browser_control_route`, `ui_surfaces`, and `ui_surface` remain detailed compatibility routes.

The connected browser cockpit/PWA is `surfaceId:"connected-browser-cockpit"`; it resolves the configured connected-host web URL, opens only through confirmed `computer action:"open_browser"` or `workspace action:"open"`, returns service/web setup routes when disabled, and reports workspace category coverage, mobile/PWA controls, Agent onboarding marker status, and browser/PWA first-run evidence.

Certified SDK/daemon browser/PWA category-route read models can make every Agent workspace category `browser-native-ready` only when they include schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata, exact inspect/open routes, and mobile/touch evidence. Certified browser/PWA first-run receipts add manifest, service-worker, install, and offline evidence with redacted URLs and summaries. Start/setup readiness still consumes the receipt from saved durable artifacts or live SDK/daemon setup read models when published, and keeps the receipt gap visible when neither source is present.

Execution routes:

- GoodVibes settings import previews changed setting/subscription counts without mutation; confirmed execution imports only Agent-owned settings and provider subscription state, redacts secret values, stores raw secret-backed values through the secret manager, and does not mutate source package stores.
- VIBE.md personality files are discovered from project/global locations, secret-scanned, surfaced in setup and the learning curator when blocked or truncated, and applied to the serial Agent prompt. Use `vibe action:"status|show"` for direct read-only inspection, `vibe action:"init|import_persona" confirm:true explicitUserRequest:"..."` for confirmed changes, or `/vibe` and the Personas workspace for the visible command surface. Unconfirmed init/import previews return model and CLI `confirmationRoutes` so users can approve the exact same personality action without reconstructing syntax.
- Project context files are discovered from the sources tabled in [getting-started.md](getting-started.md), secret-scanned, bounded, target-aware for subdirectory work, and inspectable through `context action:"files"` and `context action:"file"`.
- Local memory posture, provider inspection, curator review, search, and lookup prefer `memory`. Confirmed memory record create/update/review/stale/delete actions on `memory` forward to the local registry's confirmation gates; notes, personas, skills, routines, bundles, and detailed local record mutations dispatch through `agent_local_registry`.
- Runtime prompt context applies safe VIBE.md files, safe project context files, and only reviewed, high-confidence memory plus reviewed setup-ready behavior. Blocked or truncated VIBE.md/context files and enabled but unreviewed, stale, low-confidence, or setup-blocked local behavior are surfaced as suppressed review work.
- Prompt builds write durable receipts with ids, turn/source/model/provider, selected and suppressed record refs, segment counts, prompt hash, size, timestamp, and sanitized completed/error/cancelled outcome without storing raw prompt or response text; Agent Workspace -> Local Context shows the compact receipt outcome timeline, exact latest-receipt route, and outcome filter routes for users. Use `context action:"prompt|receipts|receipt"` for current applied order, recent receipt ids, `receiptId`/`turnId`/`outcomeStatus` filters, turn outcomes, selected records, suppressed records, and approximate token budget before relying on persistent context; use setup, project context inspection, the Memory -> Prompt plan action, or the learning curator to fix suppressed work.
- Read-only learning review uses `memory action:"curator"` and `memory action:"candidate"`; the curator returns a prompt plan with prompt-active records, suppressed review/setup/low-confidence/personality/consolidation counts, proposal queues, consolidation queues, usefulness/freshness/source-quality/risk ordering rules, and exact routes before durable context expands.
- Duplicate-consolidation candidates expose survivor ids, visible field diffs, low-level update/stale/delete/rollback routes, and first-class `agent_learning_consolidation` preview/merge/stale/delete/rollback/recreate phase routes. Merge and stale write durable receipts with rollback routes, delete refuses records that have not already been staged stale, and post-delete receipts preserve snapshots plus exact-id recreate guidance. Confirmed recreate is separate from rollback and refuses when current records would force a different id.
- Reviewed-note, completed-work, completed-research, and saved-session memory/behavior proposals reuse selected-note promotion, memory-create, or learned-behavior capture routes. Non-consolidation writes stay on `agent_local_registry` or visible workspace actions.
- Agent document draft browse/show/create/revise/review/comment/suggest/accept-suggestion/reject-suggestion/artifact-insert/export dispatches through `agent_documents`; export artifacts include reviewer-ready comment and suggestion summaries.
- Reviewer-readiness checks are visible through Agent Workspace -> Documents & Compare -> Review readiness preflight and read-only through `agent_harness mode:"document_ops"` or `mode:"document_ops_lane" laneId:"reviewer_readiness"`; they return exact routes for resolving comments, accepting/rejecting suggestions, attaching evidence, revealing comparisons, applying or leaving model-route decisions, and repairing handoff evidence before export/archive/apply.
- The review packet wizard is visible through Agent Workspace -> Documents & Compare -> Review packet wizard and read-only through `mode:"document_ops_lane" laneId:"review_packet_wizard"`; it reports six-step progress, the current user/model route, backtracking routes, refreshed-preset lineage when a packet preset was repaired, final archive review guidance, and the confirmed share route.
- Agent Workspace -> Documents & Compare -> Save packet preset and `agent_review_packet_presets mode:"save"` store one reusable local packet preset artifact with document/export/comparison/judgment/route-decision/handoff/archive/related artifact ids; `mode:"list"` and `mode:"show"` inspect presets, flag missing or superseded saved ids, and recommend newer matching reuse routes when metadata is sufficient, without mutation.
- Agent Workspace -> Documents & Compare -> Refresh packet preset and `mode:"refresh"` save a new local preset artifact from those freshness recommendations after confirmation, preserving the source preset for audit history and never mutating documents, model routes, handoffs, or archives.
- Agent Workspace -> Documents & Compare -> Share review packet and `agent_review_packet_share` validate one saved handoff archive artifact, preview the delivery target and packet evidence ids, and send only a plain-text archive reference after explicit confirmation; ZIP bytes still move through `agent_artifacts mode:"export"` or package/archive routes.
- `agent_model_compare mode:"apply"` saves an apply-winner route-decision receipt after a confirmed route update, while `mode:"routeDecision" decision:"left-unchanged"` saves a receipt without changing the selected model; `mode:"handoffArchive"` carries matching route-decision receipt artifacts into the ZIP, README, archive metadata, and redacted manifest.
- Review packet defaults use the latest document/export/comparison/judgment/route-decision/handoff evidence, falling back to saved preset metadata only when live packet evidence is missing, to prefill document export, compare handoff/archive, winner-apply, leave-unchanged decision, save-preset, and share forms while preserving editable fields and confirmation gates.
- Start deep research routing with `research action:"briefing"` when the model needs one read-only next-action queue across visible runs, source review, saved report artifacts, certified live SDK/daemon runner/render evidence, browser readiness, and exact follow-up routes.
- Use `research action:"plan"` when it needs one ordered route plan across visible run state, public web/fetch or browser posture, browser-runner contract readiness, source capture/review, visual-report packet saving, and optional Knowledge promotion.
- Use `research action:"search"` for bounded public web research that returns capture-ready source candidates and exact confirmed `add_source` routes without writing local source state; pass `runId` to use the visible run's saved question and receive run-specific start/checkpoint follow-up routes.
- Use `research action:"runner"` for the direct browser-backed runner readiness contract without the full workflow plan. The browser-runner contract names setup/fallback routes, visible run controls, source-capture receipts, bounded logs, report handoff, and certified live runner read-model fields before live browser-backed execution is treated as ready.
- The visual-report contract names report sections, source-map/citation acceptance criteria, certified browser/PWA render evidence, `research action:"report" visualReport:true` save routes, review-packet, and ZIP archive routes without saving anything by itself.
- Use `research action:"reports"` to list saved sourced report artifacts and `research action:"report_artifact" artifactId:"..."` to preview one report packet before export, archive, share, or Knowledge promotion.
- Visible research run creation/checkpoint/pause/resume/cancel/complete, log-tail inspection, source capture/review/bundles, certified live browser-runner/source-receipt evidence, certified visual-report render evidence, and confirmed sourced report saves all have direct `research` actions; run detail and mutation outputs include next-route packets for inspect, briefing, workflow, run-bound search, source queue, checkpoint, report save, artifact inspection, and Knowledge promotion when a report artifact exists.
- Source detail and mutation outputs include next-route packets for review/reject, bundle, sourced report save, mark-used, report artifact inspection, and optional URL/artifact Knowledge promotion while preserving the separate confirmation gate.
- Confirmed report saves include next-route packets for high-level report inspection, artifact export/archive, Knowledge promotion, report listing, and visible run completion when `runId` is supplied. Lower-level `agent_research_runs`, `agent_research_sources`, and `agent_research_report` remain available for detailed compatibility routes.
- Confirmed Agent Knowledge URL/file/artifact-id/bookmark/browser-history/connector ingest dispatches through `agent_knowledge_ingest`.
- Command-backed editors dispatch through `workspace action:"run_command"`.
- Learned-behavior and profile creation use the Agent-local or slash-command route.
- Web research/fetch forms return a main-conversation prompt instead of starting hidden nested work.
- Selection-based actions accept `recordId` so the model can use the same selected-record flows as the TUI.

## Background processes

Use `execution action:"processes"` for a compact list of tracked local processes, `execution action:"process" processId:"..."` for one process with bounded redacted stdout/stderr tails plus byte/count/truncation metadata, and `execution action:"capabilities"` or `action:"process_capabilities"` for the read-only terminal/process/PTY/sudo parity report.

Use `terminal` for the simple model-facing start path, as in `terminal command:"pytest -v tests/" background:true confirm:true explicitUserRequest:"..."`. Use `process` for the simple lifecycle path, through `process action:"list"`, `process action:"poll" session_id:"..."`, `process action:"log" session_id:"..."`, `process action:"wait" session_id:"..." confirm:true explicitUserRequest:"..."`, `process action:"kill" session_id:"..." confirm:true explicitUserRequest:"..."`, `process action:"write" session_id:"..." data:"..." confirm:true explicitUserRequest:"..."`, and `process action:"capabilities"`.

When the SDK or daemon publishes certified interactive runtime read models, `execution action:"status"` and `process action:"capabilities"` also show live process output chunks, typed PTY session routes, sudo credential mediation routes, and browser/desktop command receipts with schema/version/publication/publisher/provenance evidence, bounded redacted output, exact confirmed control routes, and missing certification signals. Certified browser/desktop receipts can make `computer action:"plan|control"` ready through the published daemon route; uncertified or absent records remain setup/review posture.

Use lower-level `background_processes` and `background_process` only when detailed compatibility route inspection is needed, and confirmed `run_background_process` when the lower-level harness lifecycle route is needed. The route accepts the process-tool wording `start`, `wait`, `stop`, `kill`, `poll`, `log`, and `write`; `poll` maps to status, `log` maps to output with the same explicit truncation metadata, `kill` maps to stop, and `write` requires `confirm:true`, `explicitUserRequest`, one process id, and non-empty `data`.

With the current SDK, `write` returns unsupported guidance; if the shared ProcessManager exposes a safe stdin method such as `writeInput`, Agent dispatches through that method without echoing the input back. `processId`, `processSessionId`, `sessionId`, or `session_id` all resolve the tracked process id.

Foreground `exec` remains the default for tests, builds, and one-shot commands. Raw exec background flags and `bg_*` controls are blocked in Agent so long-running work has a visible process id, process monitor/live-tail routes, timeout, and cancellation path. PTY mode returns unsupported guidance until the SDK/daemon process substrate exposes a typed interactive session API.

Background sudo prompts are blocked; privileged commands should stay visible and user-supervised. `setup action:"item" setupItemId:"sudo-execution-posture"` shows SUDO_PASSWORD presence only, the expected `~/.goodvibes/.env` location for future mediated support, blocked background sudo/stdin password routes, missing SDK/daemon contracts, and the foreground shell route without printing or storing raw password values.

## Settings and keybindings

Settings discovery accepts `settings action:"list"` with `category`, `prefix`, `query`, `includeHidden:true`, and `limit`. It is compact by default and each row includes a short first-class `modelRoute` that distinguishes read-only settings from set/reset-capable settings; use `includeParameters:true` or `settings action:"get"` for full descriptions/defaults. Single setting reads/writes resolve by `key`, `target`, or `query`; ambiguous matches are refused.

Secret-backed setting writes through `settings action:"set"` store raw values through the secret manager and return redacted output. Shared GoodVibes settings import is `settings action:"import"`; it previews by default and applies with `confirm:true explicitUserRequest:"..."`. The preview includes source-package ownership metadata so users can see that goodvibes-tui or another published GoodVibes platform store remains source-owned and is not mutated by Agent.

`import_goodvibes_settings action:"preview|apply"`, `setup action:"import_settings"`, and `workspace action:"run" actionId:"import-goodvibes-tui-settings"` remain available for compatibility or visible form parity; lower-level `agent_harness mode:"run_workspace_action"` remains a detailed compatibility route. Connected-host lifecycle/listener settings are read-only in Agent.

Workspace-checkpoint root and retention guards are configured through a manual `checkpoints` block in `settings.json`. These keys are passed straight through to the SDK's workspace checkpoint manager and are not part of the discoverable settings catalog, so `settings action:"list"` does not surface them. The recognized keys are:

| Key | Default | What it does |
| --- | --- | --- |
| `checkpoints.preferGitRoot` | on | Prefer the enclosing git repository's top level over the raw working directory |
| `checkpoints.allowBroadRoot` | off | Opt in to snapshotting a broad root such as the filesystem root, the home directory, or `~/.goodvibes` |
| `checkpoints.allowLargeFirstSnapshot` | off | Opt in to a first snapshot whose full sweep exceeds the file ceiling |
| `checkpoints.maxFirstSnapshotFiles` | SDK default | The ceiling for the first-ever snapshot's file sweep |
| `checkpoints.autoRetention` | on | Run a retention sweep automatically after each successful checkpoint and once at init |

Any key you omit falls back to the manager's own default. These guards are defense in depth; even a registered workspace can still be refused as too broad or too large.

Automatic (turn-end/lifecycle) checkpoints are restricted to workspaces COVERED by the shared registration store (restricted since 2026-07-10; store migrated to the SDK's platform/workspace/registration in SDK 1.6.1). `goodvibes-agent workspaces list|register [path] [--label <label>] --yes|unregister [path] --yes` manages the registry (path defaults to the current working directory); it is user-scoped, agent-local state, not a connected-host concept.

Coverage flows down a registered root's subtree and is inherited through the git worktree→main-repo link, so an orchestration-spawned sibling worktree of a registered repo checkpoints automatically without being registered itself. An unregistered/uncovered workspace gets no automatic checkpoints, and an explicit `checkpoints.create` gateway call against it is refused with a registration hint rather than silently registering the workspace on the caller's behalf.

`checkpoints.unregisteredWorkspaces` (`"off"` default, or `"guarded"`) is the opt-out; `"guarded"` restores the pre-restriction behavior for that workspace (automatic checkpoints subscribe, explicit create proceeds) subject only to the root/retention guards above. `goodvibes-agent status`/`doctor` state the posture honestly: `checkpoints off: workspace not registered` when off, never silent.

Best-of-N attempt groups (SDK 1.6.1 orchestration engine) are reviewed and resolved with `goodvibes-agent fleet attempts list [--workstream <workstreamId>]|pick <groupId> <winnerItemId> --yes|judge <groupId>`. This reads this Agent's own orchestration engine state directly (disk-persisted workstream snapshots), not a connected-host call. `fleet.attempts.*` is a ws-only gateway verb family with no HTTP binding, so neither this CLI command nor `agent_operator_method` can reach it over HTTP.

`list` shows every held-merge group (siblings that ran in isolated worktrees and are held for a winner pick instead of auto-merging) with each candidate's diff, usage, and any prior judge proposal. `judge` runs the optional judge model and PROPOSES a winner, always rendered as a clearly labeled model proposal, never a decision, and `pick` is the confirm-gated action that actually merges the winner and cleans losing worktrees.

Keybinding discovery returns fixed shortcuts plus the live resolved binding table. Fixed shortcuts and configurable bindings include direct `modelRoute` and `modelAccess` metadata so the model can distinguish supported routes from direct-user-only controls. `workspace action:"run_keybinding"` only executes actions with faithful current-shell routes. Prompt-editor-only shortcuts, terminal text selection, category cycling, and reserved shortcuts stay direct user interaction.

## Connected host and daemon

The connected host is external. Agent can inspect it through:

- `host action:"services|service"` for endpoint binding, network-facing posture, issues, optional probes, and redacted log tail.
- `host action:"capabilities|capability"` for compact connected-host posture, direct `modelRoute` hints, route families, allowed capabilities, blocked lifecycle/non-Agent surfaces, and first-class tool availability.
- `host action:"status"` for live read-only readiness checks and the next diagnostic route.
- `setup action:"repair"` for the current setup blocker or a named host/auth/service target; it returns the safest next route without executing lifecycle, token, import, or UI effects.
- `setup action:"item" setupItemId:"connected-host-readiness"` for the missing-host bootstrap plan: user-run Bun, GoodVibes host install/trust, binary verification, service start, and Agent reconnect commands before operator methods are reachable.
- `host action:"methods|method"` for the public method catalog.

None of those modes expose host start, stop, restart, install, expose-listener, connected-host account or route mutation, default knowledge access, hidden background Agent jobs, or implicit delegated review. Those daemon mutations are reached through `agent_operator_method` with `confirm:true` instead. This says nothing about signing up for a third-party service; that is authorized, and it is recorded with `accounts action:"record"` rather than gated.

## Visible autonomy

Use `autonomy action:"intake"` first when the user asks for ongoing work and the safest route is not obvious. It is read-only and returns the likely route, missing fields, confirmation boundary, and trigger workflow posture for time-based wakeups/schedules, incoming webhooks/watchers, Gmail/email connector triggers, and control-plane event streams.

Webhook, watcher, Gmail, or event-trigger requests point to the published `watchers.create` contract when applicable, but watcher creation is an admin connected-host mutation that requires trusted source/scope, a task or run target, success criteria, `confirm:true`, and `explicitUserRequest`. The intake action also returns watcher receipt success criteria plus a read-only watcher evidence contract for SDK/daemon-owned durable run-history receipts, provider source records, redacted event payload descriptors, and autonomy queue correlation. Confirmed `agent_operator_method` calls summarize `watchers.create/update/run/start/stop/delete` receipts into certified or follow-up outcomes without exposing operator tokens.

Use `schedule action:"create"` for one visible autonomous schedule, `schedule action:"remind"` for reminders, `schedule action:"edit"` for one exact schedule edit, and `schedule action:"run|pause|resume|delete"` for lifecycle controls; it forwards to the same preview, read-only current-state diff, confirmation, and connected-host routes as `agent_autonomy_schedule`, `agent_reminder_schedule`, `agent_schedule_edit`, and allowlisted `agent_operator_action`, then returns post-action next routes for schedule list, autonomy queue inspection, run, edit, pause, resume, and delete where the schedule still exists. Unconfirmed schedule and routine-promotion previews return `confirmationRoutes` so the user or model can confirm the same intent without guessing the next command. Confirmed routine schedule promotion through the workspace or `/schedule promote-routine` returns the same post-action schedule next routes.

Use `autonomy action:"queue"` before creating recurring autonomous work, reminders, routine schedules, delegated work, run controls, schedule edits, approval decisions, watcher triggers, or follow-up delivery. The queue is read-only and normalizes work-plan, research-run, connected task, approval, automation, schedule, reminder, routine-promotion, delegated-agent, and delivery cards. Research runs, connected-host tasks, approvals, automation runs, SDK/daemon watcher run/source records, and schedules include live records with status/progress, source ids, next steps, log tails when available, task retry/output/correlation diagnostics, bounded redacted host task and watcher output route/preview descriptors, automation telemetry/delivery/route diagnostics, watcher run-history/source diagnostics, available controls, unavailable controls with reasons, and exact inspect/checkpoint/pause/resume/cancel/approve/deny/retry/run/edit/enable/disable/delete routes where supported.

Provider-source watcher records are read-only context with inspect/refresh controls; watcher run effects appear only when the owning SDK or daemon publishes exact confirmed routes. Schedule records expose pause/resume aliases over daemon enable/disable lifecycle routes so users do not have to translate scheduler terminology. Connected-host task cancel/retry uses `agent_operator_method` exact daemon methods with `confirm:true` plus `explicitUserRequest`; slash `/tasks` remains inspection-only.

Inspect one card with `autonomy action:"item"`; lower-level `agent_harness mode:"autonomy_intake|autonomy_queue|autonomy_queue_item"` remains available for detailed route inspection. Create, edit, run, pause, resume, cancel, approve, deny, send, schedule, and schedule lifecycle effects stay on the owning confirmed route returned by that card.

## Agent Knowledge

Use the Knowledge workspace first. Scriptable mirrors:

```sh
goodvibes-agent ask "<query>"
goodvibes-agent search "<query>"
goodvibes-agent knowledge list --kind sources
goodvibes-agent knowledge get <id>
goodvibes-agent knowledge map
goodvibes-agent knowledge connectors
goodvibes-agent knowledge connector <connector-id>
goodvibes-agent knowledge connector-doctor <connector-id>
goodvibes-agent knowledge ingest-url <url> --yes
goodvibes-agent knowledge ingest-file <path> --yes
goodvibes-agent knowledge ingest-connector <connector-id> --yes
goodvibes-agent knowledge import-urls <path> --yes
goodvibes-agent knowledge import-bookmarks <path> --yes
goodvibes-agent knowledge import-browser-history --yes
goodvibes-agent knowledge reindex --yes
/knowledge queue
/knowledge review-issue <issue-id> resolve --yes
/knowledge packet <task>
/knowledge explain <task>
/knowledge consolidate light --yes
```

Agent rejects route-selection flags that would target another knowledge space, including `--space`, `--knowledge-space`, `--knowledge-space-id`, and `--include-all-spaces`. Parseable public Agent-route scope aliases are normalized; contaminated connected-host responses return `scope_contamination`.

## Approvals, automation, and schedules

Read views are safe by default. Mutations require exact target ids and confirmation:

```text
/approval approve <approval-id> [--note <text>] [--remember|--no-remember] --yes
/approval deny <approval-id> [--note <text>] [--remember|--no-remember] --yes
/approval cancel <approval-id> [--note <text>] [--remember|--no-remember] --yes
/automation job run <job-id> --yes
/automation job pause <job-id> --yes
/automation job resume <job-id> --yes
/automation run cancel <run-id> --yes
/automation run retry <run-id> --yes
/automation schedule <run|enable|disable|delete> <schedule-id> --yes
/schedule run <schedule-id> --yes
/schedule enable <schedule-id> --yes
/schedule disable <schedule-id> --yes
/schedule delete <schedule-id> --yes
/schedule edit <schedule-id> [--cron <expr>|--every <interval>|--at <iso-time>] [--timezone <tz>] [--name <text>] [--prompt <text>|--task <text> --success-criteria <text>] --yes
```

Routine promotion is an explicit scheduling route. Local routines stay local until a user confirms promotion. Delivery targets are opt-in with explicit channel/route/webhook/link flags.

## Slash command catalog

| Command | Purpose |
| --- | --- |
| `/accounts` | Review provider auth routes, subscription windows, and billing-path safety. |
| `/activity` | Show running work, what needs you, what is coming up, and recent activity (also Ctrl+O). |
| `/agent` | Open the GoodVibes Agent operator workspace. |
| `/agent-profile` | Manage isolated Agent profiles and starter templates, including opt-in VIBE.md starter export/import with `--include-vibe`. |
| `/approval` | Review approval classes and run exact confirmed approval actions. |
| `/auth` | Review provider auth posture and export redacted auth review bundles. |
| `/automation` | Run confirmed connected-host automation actions from the Agent TUI. |
| `/bookmarks` | List bookmarked transcript blocks. |
| `/brief` | Show a concise Agent operator briefing and next actions. |
| `/bundle` | Export, inspect, or import redacted Agent support bundles from the TUI. |
| `/calendar` | Manage a local calendar: list upcoming events, import or export .ics files, and add or remove events. |
| `/channel-profiles` | List, set, or delete per-channel session profile bindings (model, provider, permission mode) on the connected host; mutations require `--yes`. |
| `/channels` | Inspect channel readiness, delivery receipts, or send one explicitly confirmed delivery message. |
| `/ci` | Check a repo or PR's CI with per-job conclusions and manage standing CI watches with channel delivery; mutations require `--yes`. |
| `/clear` | Clear the conversation display while keeping LLM context. |
| `/collapse` | Collapse rendered blocks by type. |
| `/commands` | Browse all commands in a scrollable list. |
| `/compact` | Summarize the conversation to free context window. |
| `/compat` | Inspect connected-host compatibility and Agent Knowledge route readiness. |
| `/config` | Open the fullscreen configuration workspace. |
| `/context` | Inspect context-window usage and token breakdown; `/context window [<size>\|clear]` shows where the current model's window came from, or sets or clears a custom window. |
| `/conversation` | Review conversation structure, transcript hotspots, and composer posture. |
| `/delegate` | Explicitly delegate build/fix/review work to GoodVibes TUI with reason, success criteria, workspace hint, priority, and explicit review intent. |
| `/effort` | Show or set reasoning effort level. |
| `/email` | Configure direct email, read inbox summaries read-only, and send a confirmed message. |
| `/expand` | Expand rendered blocks by type. |
| `/export` | Export the current conversation to Markdown. |
| `/google` | Connect the Google account behind mail and calendar: adopt credentials already on this machine, or run the setup flow. |
| `/health` | Review startup posture, connected-host readiness, provider health, and Agent continuity. |
| `/help` | Show available commands and keyboard shortcuts. |
| `/image` | Attach an image file to the next message. |
| `/keybindings` | List keyboard bindings and the config file path. |
| `/knowledge` | Use isolated Agent Knowledge. |
| `/load` | Load a saved Agent session. |
| `/mcp` | Manage MCP servers, trust posture, and tool inventory. |
| `/media` | Inspect media providers or generate media through configured providers. |
| `/memory` | Add, search, review, stale, or delete Agent-local memory records. |
| `/mode` | Manage Agent interaction mode and per-domain verbosity. |
| `/model` | Select or display the current LLM model. |
| `/network-scan` | Turn local-network scanning for model servers on or off, or check its status. Off until explicitly turned on; never scans silently on first run. |
| `/next-error` | Jump to the next error message in the conversation. |
| `/notes` | Open Agent-local scratchpad notes in the operator workspace. |
| `/notifications` | Show every notice and notification in full, newest first (each notice also shows briefly as a toast). |
| `/notify` | Manage and send configured Agent webhook notifications. |
| `/paste` | Insert clipboard text or image into the prompt. |
| `/owner-profile` | Your profile: read what GoodVibes knows about you, show one field, look one person up by name, trace where a fact came from, correct one, or forget one. Here the People section is counted rather than listed, because this output lands in the transcript; the same command at a shell prints the full list. |
| `/payments` | Enter the payment card (masked input: number, expiry, CVV, cardholder name) and the billing/shipping addresses the daemon uses for purchases. Card material is stored at daemon scope and never rendered back; budgets, windows and CVV handling live in Settings > Payments. |
| `/personas` | Manage Agent-local personas. |
| `/pin` | Pin a model to the favorites list. |
| `/prev-error` | Jump to the previous error message in the conversation. |
| `/principals` | Manage the connected host's cross-channel principal identity registry; unmapped senders show as "unknown principal" in session attribution. |
| `/provider` | Switch provider or manage custom providers. |
| `/qrcode` | Print companion pairing details and a QR code. |
| `/quit` | Exit the application. |
| `/redo` | Redo the last undone conversation turn. |
| `/refresh-models` | Refresh model catalog, metadata, and token limits. |
| `/reset` | Clear display and conversation context. |
| `/retry` | Re-send the last user message, optionally with modified text. |
| `/routines` | Manage Agent-local routines and explicit routine schedule promotion. |
| `/save` | Save the current session. |
| `/schedule` | Inspect schedules, create confirmed reminders, and promote routines to connected schedules. |
| `/secrets` | Manage secrets, external secret refs, and storage policy. |
| `/security` | Inspect security posture, attack paths, and review state. |
| `/session` | Inspect session continuity and cross-session graph state. |
| `/sessions` | List saved sessions. |
| `/settings` | Open, inspect, set, or reset Agent settings. |
| `/setup` | Open the Agent workspace; on a fresh Agent home the workspace opens into setup first. |
| `/shortcuts` | Show keyboard shortcuts. |
| `/skills` | Manage Agent-local skills and skill bundles. |
| `/status` | Show the current model and its context window, with where the window came from (its catalog provider, the consensus of catalog providers, a family default, or a user override). |
| `/subscription` | Manage provider subscription sessions. |
| `/tasks` | Inspect connected-host tasks without starting or mutating local background work. |
| `/title` | Show or set the conversation title. |
| `/trust` | Review trust posture and export portable trust bundles. |
| `/tts` | Submit a normal prompt and play the assistant response through live TTS. |
| `/undo` | Undo the last conversation turn. |
| `/unpin` | Unpin a model from the favorites list. |
| `/update` | Check for a newer release; for binary installs, verify and apply it or roll back to the kept previous version. |
| `/vibe` | Inspect, create, show, or import VIBE.md personality files. |
| `/voice` | Review voice posture, provision the managed local-voice runtime and the wake-word models (`/voice wake status`, `/voice wake setup --yes`), and export portable voice metadata. |
| `/welcome` | Open the Agent workspace, or print the setup guide with `/welcome print`. |

## Related docs

- [Getting started](getting-started.md)
- [Connected host](connected-host.md)
- [Knowledge, artifacts, and multimodal](knowledge-artifacts-and-multimodal.md)
- [Channels, remote access, and API](channels-remote-and-api.md)
- [Release and publishing](release-and-publishing.md)
