# Getting started

GoodVibes Agent is the installable autonomous operator assistant for GoodVibes.

## Requirements

- Bun `1.3.14` or newer.
- A connected GoodVibes daemon or compatible host with operator routes. Installing this package installs one: it depends on `goodvibes-daemon`.
- Token/config state accepted by that daemon.

## Install from package

```sh
bun add -g @pellux/goodvibes-agent
bun pm trust -g goodvibes-daemon
goodvibes-agent --help
goodvibes-agent
```

Bun blocks lifecycle scripts for untrusted global packages. This package depends on `goodvibes-daemon`, so one install brings both commands. It needs trusting so its own postinstall can place the daemon binary. Nothing else needs trusting: this package has no postinstall of its own, and its libraries are bundled into the published runtime. Verify the install with:

```sh
bun pm -g untrusted
goodvibes-agent --version
goodvibes-daemon --version
```

The two versions differ on purpose. The Agent and the daemon are separate products on separate version lines.

If `goodvibes-agent` is not on `PATH`:

```sh
export PATH="$(bun pm bin -g):$PATH"
goodvibes-agent --help
```

`goodvibes-agent` starts the interactive TUI. On a fresh Agent home, setup opens first. After setup is applied, the TUI opens directly into the Agent workspace.

## Run from source

```sh
git clone https://github.com/mgd34msu/goodvibes-agent.git
cd goodvibes-agent
bun install
bun run dev
```

## First run

Use the interactive workspace first. CLI subcommands are secondary support paths for install checks, setup inspection, and scriptable mirrors.

The workspace opens into a set of operator areas. Each area below names what it covers; the Setup area carries the guided path from a fresh install to a working connected host and model route, and the rest become useful as soon as setup is applied.

- Setup:
  - guided first-run wizard with progress, current-step route hints, saved setup checkpoints, checkpoint auto-advance evidence when a saved step is already ready, backtracking routes, setup-smoke rerun/save routes, repeated-blocker focus from saved smoke history, and closeout state from critical blocker, saved smoke, durable setup receipt, and user completion-marker evidence
  - visible checklist for runtime, connected-host auth, provider/model, install smoke, and follow-on capabilities
  - prioritized first-run plan
  - primary handoffs from every actionable setup row to the safest visible form, diagnostic, or confirmed route
  - GoodVibes settings import preview/apply
  - read-only setup repair decisions
  - token-safe install smoke checks
  - confirmed setup smoke execution with saved redacted evidence artifacts and Home/setup latest-result plus history/trend surfacing
  - setup readiness that can auto-advance connected-host service/auth/install-smoke/browser-PWA rows from saved durable artifacts, live SDK/daemon setup receipt read models, or ordered setup receipt event streams with secret-looking receipt text redacted and schema/version/provenance/publication/cursor evidence surfaced for certified receipts
  - confirmed onboarding finish marker write
  - route-level provider-health-backed model readiness scores
  - Model Routing readiness and benchmark-evidence actions
  - hardware-scored local model cookbook with setup/download guidance
  - certified local serving diagnostics with host-published start/repair route evidence
  - confirmed benchmark action/history
  - connected-host compatibility reporting against the public Agent routes
  - live service probe evidence
  - token-safe connected-host auth posture with exact pairing route ids
  - confirmed local token create/repair
  - offline GoodVibes host bootstrap commands
  - diagnostic/status repair recommendations
  - inspect-first confirmed service install/start/restart routes with success criteria and certified service receipt outcomes
  - Agent Knowledge readiness
  - isolated Agent profile creation and switching
  - redacted support bundle export for troubleshooting handoffs
  - provider subscription session posture
  - provider auth review with redacted export
- Home: assistant cockpit lanes for setup, chat/model choice, browser cockpit/PWA handoff, project work, Personal Ops, research/docs, background supervision, and safety/recovery, plus briefing, model refresh, health, doctor, and compatibility actions.
- Knowledge: isolated Agent Knowledge status, ask/search, inspection, and confirmed ingest.
- Research: read-only web research and URL inspection, a visible Research briefing next-action queue, workflow planning with bounded public source-candidate search, certified live SDK/daemon browser-runner and visual-report render evidence when published, project-local visible research runs with log tails, browser-backed runner readiness/fallback posture, source queue, credibility review, reviewed-source bundles, plus confirmed sourced report artifacts with source maps, citation coverage checks, repair hints, and optional visual report packets.
- Documents & Compare:
  - versioned markdown document drafts
  - review comments
  - AI suggestion review
  - draft browse/show/create/revise/review/suggest/accept/reject/artifact-attach/artifact-insert/export with reviewer-ready comment and suggestion summaries
  - chronological review packet timeline across document/comment/suggestion/compare/judgment/route-decision/packet-preset/handoff/archive events with stale preset attention
  - a read-only review packet wizard with progress/current-step routes/backtracking/final archive review/refreshed-preset lineage/share handoff
  - visible reviewer-readiness preflight before export/archive/apply
  - inline readiness badges at document export, reviewer handoff/archive, and route-apply forms
  - packet defaults that prefill the next export/handoff/archive/apply/leave-unchanged/save-preset/share ids from the latest review packet while falling back to saved preset metadata only when live evidence is missing
  - file uploads into saved artifacts
  - document and artifact exports to workspace files
  - source checks against attached evidence
  - generated media artifacts
  - saved artifact browse/show/export/package/archive
  - reviewed artifact-to-Knowledge promotion
  - saved packet preset save/list/show/refresh routes with missing/superseded id freshness checks and confirmed refresh into a new preset artifact
  - confirmed reviewer packet share through `agent_review_packet_share` with channel target preview and no ZIP-byte transcript output
  - saved text artifact reuse in blind comparison
  - confirmed blind model comparison with:
    - delayed reveal
    - durable JSON comparison artifacts
    - saved review boards
    - side-by-side reviewer views
    - split-pane reviewer handoff diffs with section jumps plus recent-handoff defaults and visible recent choices
    - saved judgment artifacts
    - confirmed apply and leave-unchanged route-decision receipts
    - task/document/benchmark-filtered preference analytics/synthesis
    - markdown report export
    - reviewer handoff artifacts
    - one-click reviewer handoff ZIP archives with matching route-decision receipt evidence
    - confirmed winner route updates
- Personal Ops:
  - a read-only daily briefing plan across inbox, agenda, tasks, reminders, routines, delivery, notes, and the autonomy queue
  - a read-only review queue for saved inbox thread/calendar event items, refreshable provider-read routes, daemon/SDK provider read-model records, and follow-up boundaries
  - inbox/calendar connector readiness
  - request intake that turns "triage my inbox", "brief my calendar", task, reminder, note, routine, and delivery asks into the safest lane/route/fields/confirmation boundary
  - email/calendar-capable MCP setup routes
  - expanded connector tool classification for read-only versus write-like inbox/calendar actions
  - schema-derived operation records with required fields, sample inputs, schema routes, confirmation flags, and fresh-read routes
  - inbox triage/draft and calendar agenda/conflict workflow cards with inspect routes
  - ordered execution plans for connector reads/local drafting/confirmed effects
  - confirmed read-only MCP execution for selected inbox/calendar reads with bounded redacted output
  - normalized review cards
  - optional saved redacted review-card artifacts
  - structured next-route packets for refresh/lane/queue/artifact/local-draft/confirmed-effect boundaries
  - saved review artifacts resurfaced as redacted inbox thread/calendar event queue records
  - certified provider-effect receipts for inbox/calendar/task/reminder outcomes
  - fresh daemon/SDK-published inbox/calendar/task/reminder queue records with durable ids, labels, redacted snippets/notes, agenda windows, conflict signals, due times, cadence, delivery targets, freshness status, source paths, schema/version/publication/publisher/provenance/receipt evidence, read-only inspect routes, local draft/reminder follow-up routes, and confirmed provider-effect boundaries only when matching routes are published
  - live records for Agent-owned notes, routines, schedule receipts, delivery channels, and redacted delivery receipts
- Memory & Skills:
  - VIBE.md personality inspection and import
  - project context file inspection
  - durable Agent-local memory records
  - scratchpad notes
  - reusable personas
  - reusable skills and skill bundles
  - startable routines with explicit schedule promotion
  - learned behavior capture from completed work
  - prompt injection limited to safe VIBE.md, safe project context, and reviewed/confident setup-ready behavior
  - visible Local Context and Personas workspace health counts for VIBE.md/project context files
  - setup/curator visibility for blocked or truncated VIBE.md files
  - model-visible context inspection for blocked or truncated project context files
  - a Prompt context action that shows the currently applied prompt order, recent durable receipt ids, selected/suppressed context records, and approximate token budget
  - a Prompt plan action that explains prompt-active records, suppressed review/setup work, proposal queues, consolidation queues, and scored review routes before context expands
  - a learning curator for review/setup/stale/duplicate-consolidation/reviewed-note/completed-work/completed-research/saved-session memory and behavior candidates, including guided duplicate-consolidation phase helpers with receipts
- Channels: companion pairing, an ordered channel setup guide, channel readiness, channel triage, notification targets, allowlist/status review, redacted confirmed-send receipts, and confirmed sends.
- Voice & Media: TTS setup, image input, confirmed generated media, voice workflow posture, certified companion device capability readiness when the SDK/daemon publishes permission-scoped records, and browser/PWA readiness with certified category-route and first-run receipt evidence when the connected host publishes it.
- Work & Automation: work-plan tracking, approvals, schedules, reminders, and explicit operator actions.
- Operator Runtime: daemon status, method discovery, confirmed write/admin routes, visible autonomous agents, and cancellation/status follow-up.

Press `/` inside the Agent workspace to search actions by name, category, command, or detail.

## Model access

The main Agent model can use the Agent-controlled harness through Agent-owned tools. Use `agent_harness mode:"summary"` for a compact map, `mode:"modes"` to search every harness mode by task or id, and `mode:"mode"` to inspect one mode contract. Then drill into plural catalogs or single-item inspect modes.

Default discovery is intentionally compact:

- plural modes return ids, labels, counts, safe state, effect class, and route hints;
- workspace action, slash-command, CLI, UI surface, shortcut/keybinding, settings, tool, connected-host posture/status/capability, and operator/audit catalogs include short `modelRoute` or `modelAccess` hints for route choice;
- singular modes return detailed policy and lookup metadata;
- `includeParameters:true` adds schemas, editor fields, model routes, parameter hints, release artifact data, redacted log tail, and detail that would be too large for normal discovery.

Common model routes:

| Need | Tool Or Mode |
| --- | --- |
| Choose the best route for a user task | `route action:"plan" query:"..."`; host diagnostics route through `host action:"status"`; settings route through `settings action:"list"`; model provider/local-cookbook/smoke/route-fit requests route through `models action:"provider\|local\|smoke\|route"`; Personal Ops briefing/queue/fresh-read/connector requests route through `personal_ops action:"briefing\|queue\|intake\|lane"`; reminders/schedules route through `schedule action:"list"`; local background commands route through `execution action:"processes"`; interactive PTY/stdin/sudo questions route through `execution action:"process_capabilities"`, which surfaces certified daemon runtime records when published; external memory-provider/backend/sync requests route through `memory action:"provider"` or the provider checklist, which shows provider-specific next routes, certified live read-model status when published, certified receipt evidence, and remaining checks before provider effects; browser-backed research runner requests route through `research action:"runner"`; visual research report rendering routes through `research action:"plan"` plus report artifacts; voice workflow and TTS-provider requests route through `device action:"voice\|provider"`; browser cockpit/PWA requests route through `computer action:"browser"` before confirmed open handoff; channel setup/triage/delivery-receipt/send requests route through `channels action:"setup\|triage\|deliveries\|channel"`; permission posture/finding/blocked-action questions route through `security action:"status\|finding\|explain"`; support-bundle requests route through `support action:"status\|bundle"`; saved-session/bookmark/continuity requests route through `sessions action:"list\|search\|get"`; release readiness/evidence requests route through `audit action:"readiness\|evidence\|item\|artifact"`; file undo/redo routes through `execution action:"recovery"`; media generation routes through provider readiness plus `agent_media_generate`; screenshot/browser/desktop-control tasks route through `computer action:"plan"`; lower-level `agent_harness mode:"route_decision"` remains available for compatibility/detail |
| Harness mode discovery | `agent_harness mode:"modes"`, `mode:"mode"` |
| Workspace actions | `workspace action:"status\|actions\|action\|run"`; lower-level workspace harness modes remain available for compatibility/detail |
| Slash commands | `workspace action:"commands\|command\|run_command"`; lower-level command harness modes remain available for compatibility/detail |
| Settings | `settings action:"list\|get\|set\|reset\|import"`; lower-level `agent_harness mode:"settings"`, `mode:"get_setting"`, `mode:"set_setting"`, `mode:"reset_setting"` remain available for compatibility/detail |
| GoodVibes settings import | `settings action:"import"` previews by default; apply with `confirm:true explicitUserRequest:"..."`; `import_goodvibes_settings action:"preview\|apply"` remains available |
| Visible UI and devices | `workspace action:"surfaces\|surface\|open"` for visible navigation; `computer action:"status\|plan\|control\|browser\|setup\|mcp\|open_browser"` for browser/PWA readiness, certified browser-native category routes and first-run receipts, browser/screenshot/desktop-control planning, and computer-use UX; `device action:"status\|capability\|voice\|provider\|open_tts_provider\|open_tts_voice"` for device/voice UX |
| Keybindings | `workspace action:"shortcuts\|keybindings\|keybinding\|run_keybinding\|set_keybinding\|reset_keybinding"` |
| Tool contracts | `agent_harness mode:"tools"`, `mode:"tool"` |
| Agent Knowledge | `agent_knowledge`, `agent_knowledge_ingest` |
| Research runs, sources, and reports | `research action:"briefing\|plan\|search\|runner\|runs\|run\|sources\|source\|bundle\|reports\|report_artifact\|create_run\|start_run\|checkpoint\|pause\|resume\|cancel\|complete\|fail\|delete_run\|add_source\|review_source\|reject_source\|use_source\|delete_source\|report"`; lower-level `agent_research_runs`, `agent_research_sources`, `agent_research_report`, and harness research modes remain available for detailed inspection |
| Personal operations | `personal_ops action:"briefing\|status\|queue\|intake\|lane\|read"`; lower-level `agent_harness mode:"personal_ops_briefing"`, `mode:"personal_ops_queue"`, `mode:"personal_ops_intake"`, `mode:"personal_ops"`, `mode:"personal_ops_lane"`, and `mode:"run_personal_ops_read"` remain available for detailed inspection |
| Visible autonomy | `autonomy action:"intake\|queue\|item\|status"`; lower-level `agent_harness mode:"autonomy_intake"`, `mode:"autonomy_queue"`, and `mode:"autonomy_queue_item"` remain available for detailed inspection |
| Model and local model choice | `models action:"status\|route\|local\|providers\|provider\|smoke"` for route readiness with route-level provider-health records, local cookbook, certified daemon-published local serving diagnostics, provider posture, and confirmed local smoke checks; lower-level `agent_harness mode:"model_routing"`, `mode:"model_route"`, `mode:"provider_accounts"`, `mode:"provider_account"`, and `mode:"run_local_model_smoke"` remain available for detailed inspection |
| Local background processes | `execution action:"processes\|process"` for inspection, `execution action:"process_capabilities"` for PTY/stdin/sudo posture, `terminal command:"..." background:true` to start, and `process action:"list\|poll\|log\|wait\|kill"` for lifecycle controls |
| Documents, artifacts, compare | `agent_harness mode:"document_ops"`, `mode:"document_ops_lane"`, `agent_documents`, `agent_review_packet_presets`, `agent_review_packet_share`, `agent_artifacts`, `agent_model_compare` |
| VIBE.md, project context, and local memory/notes/personas/skills/routines | `vibe action:"status\|show\|init\|import_persona"`, `/vibe`, `context action:"status\|files\|file\|prompt\|receipts\|receipt"`, `memory action:"status\|provider\|curator\|candidate\|list\|search\|get"` for local memory plus external provider next routes/checklists/receipt contracts, `agent_local_registry`, `agent_learning_consolidation`, or confirmed workspace actions |
| Learning curator and prompt plan | `memory action:"curator" includeParameters:true`, `memory action:"candidate"`, `agent_learning_consolidation`; lower-level learning harness modes remain available for detail |
| Work plan | `agent_work_plan` including confirmed `dispatch_agents` for approved visible-agent work |
| Visible autonomous work | `agent_harness mode:"agent_orchestration"`, `mode:"agent_orchestration_agent"`, then `agent` with `mode:"spawn"`, `mode:"batch-spawn"`, `mode:"status"`, `mode:"message"`, `mode:"wait"`, or `mode:"cancel"` |
| Channels, notifications, reminders, scheduled autonomy, media | `channels action:"status\|channel\|setup\|triage\|deliveries"`, `agent_channel_send`, `agent_notify`, `schedule action:"list\|create\|remind\|edit\|run\|pause\|resume\|delete"`, lower-level channel harness modes and `agent_reminder_schedule`/`agent_autonomy_schedule`/`agent_schedule_edit`, `agent_media_generate` |
| Operator state/actions | `agent_operator_briefing`, `agent_operator_action`, `agent_operator_method`; inspect method contracts with `host action:"methods\|method"` |
| Connected host/daemon posture | `host action:"status\|capabilities\|capability\|services\|service\|methods\|method"`; lower-level connected-host harness modes remain available for detailed inspection |
| First-run setup plan | `setup action:"status"` exposes `setupCloseout`; use `action:"repair"` for the safest next repair route, `action:"item"`, `action:"checkpoint"`, `action:"save_checkpoint"`, `action:"clear_checkpoint"`, `action:"token"`, `action:"smoke"`, and confirmed `action:"finish"` for the guided setup path |
| Operator/audit evidence | `audit action:"readiness\|item\|evidence\|artifact"`; lower-level `agent_harness mode:"release_evidence"`, `mode:"release_evidence_artifact"`, `mode:"release_readiness"`, and `mode:"release_readiness_item"` remain available |

All effects require explicit user request and confirmation. Ambiguous lookup is refused with candidates.

Registered tool definitions are intentionally terse. The default model catalog keeps top-level descriptions short, removes nested parameter descriptions, and includes direct harness inspection routes; use `agent_harness mode:"tools"` with `includeParameters:true`, `mode:"tool"`, or the owning harness mode when detailed contracts are needed.

## Isolated Agent profiles

Use a separate Agent home for isolated local state:

```sh
GOODVIBES_AGENT_HOME=/path/to/agent-home goodvibes-agent
```

Use named Agent profiles from Agent Workspace -> Profiles. Scriptable equivalents:

```sh
goodvibes-agent profiles templates
goodvibes-agent profiles create household --template household --yes
goodvibes-agent profiles use household --yes
goodvibes-agent --agent-profile household
goodvibes-agent profiles templates export research ./research-starter.json --include-vibe --yes
goodvibes-agent profiles templates import ./research-starter.json --yes
```

Named profiles isolate Agent-local config, sessions, VIBE.md, memory, notes, personas, skills, routines, and setup state. Starter export/from-discovered flows can include the current safe VIBE.md with `--include-vibe`; blocked VIBE.md files must be repaired first. Shared GoodVibes settings import can reuse existing provider, UI, permission, subscription, surface, tool, and daemon endpoint settings from goodvibes-tui and other published GoodVibes platform stores. The direct `settings action:"import"` route, `import_goodvibes_settings` compatibility route, and workspace action all preview changed counts first, show source-package ownership metadata, redact secret values, and require confirmation before applying Agent-owned settings or provider subscriptions without mutating the source package stores.

## Local behavior

VIBE.md is the friendly personality file for GoodVibes Agent. Project and global VIBE.md files are discovered, scanned for secret-looking content, surfaced in the Local Context and Personas workspaces, setup, and the learning curator when blocked or truncated, optionally carried through profile starter export/import with `--include-vibe`, and applied to the serial Agent conversation. The model-visible route is `vibe action:"status|show"` for inspection and `vibe action:"init|import_persona" confirm:true explicitUserRequest:"..."` for confirmed personality changes; previews also return exact model and CLI `confirmationRoutes` for the same init/import action. They do not write into default knowledge or other product segments.

Project context files are workspace instructions, not personality. GoodVibes Agent discovers them from these sources, in this application order:

| Source | Where it is discovered | What it is |
| --- | --- | --- |
| `HERMES_HOME/SOUL.md` | Only when the `HERMES_HOME` environment variable is set | Global instruction file, applied before everything else |
| `.hermes.md`, `HERMES.md` | Every directory from the project root down to the target directory | Hermes-convention project instruction files |
| `AGENTS.md` | The same directory walk | The shared cross-agent instruction file convention |
| `CLAUDE.md` | The same directory walk | Claude-convention project instruction file |
| `.cursorrules` | The working directory | Cursor's single-file rules format |
| `.cursor/rules/*.mdc` | The working directory, sorted by filename | Cursor's per-rule files |

Every discovered file is scanned for secret-looking content, and bounded safe content is applied to the serial Agent prompt. Local Context shows loaded/blocked/truncated counts, and `context action:"files"` and `context action:"file"` expose loaded or blocked files to the model. Subdirectory context is discovered when a target path is supplied.

Memory, notes, personas, routines, and Agent skills are local to GoodVibes Agent. Only reviewed, high-confidence local context should steer the assistant. Prompt context includes reviewed memory at or above the durable confidence threshold and reviewed setup-ready skills, routines, bundles, and personas. Enabled but unreviewed, stale, low-confidence, setup-blocked, or blocked context records are surfaced as suppressed review work instead of being applied silently.

Prompt builds write durable receipts with ids, turn/source/model/provider, selected and suppressed record refs, segment counts, prompt hash, size, timestamp, and sanitized completed/error/cancelled outcome without storing raw prompt or response text. Agent Workspace -> Local Context shows a compact receipt timeline with outcome counts, latest turn outcome, applied/suppressed counts, bounded outcome detail, exact latest-receipt drill-in, and outcome filter routes.

Use `context action:"prompt"`, `context action:"receipts"`, or `context action:"receipt"` when the model or operator needs the current applied order, recent receipt ids, exact `receiptId`, `turnId`, or `outcomeStatus` filtering, turn outcomes, selected records, suppressed records, prompt previews on request, and approximate token budget.

Use the workspace first:

- Memory & Skills -> Create memory, Create note, or Capture learned behavior.
- Memory & Skills -> Prompt plan to see which reviewed memories and setup-ready behaviors can guide the assistant now, what is suppressed, and which scored review/proposal/consolidation routes should run before context expands.
- Memory & Skills -> Learning curator to rank stale, low-confidence, missing-setup, VIBE.md personality health, duplicate-consolidation candidates with visible diffs and rollback/recreate routes, expose an ordered duplicate-consolidation batch review plan, apply confirmed merge/stale/delete/rollback/recreate phases through `agent_learning_consolidation`, surface reviewed-note memory/behavior proposals, completed-work memory/behavior proposals, completed-research memory/behavior proposals, saved-session memory/behavior proposals, and review-needed local behavior records before they silently guide the assistant.
- Local Context -> Prompt context, Inspect VIBE.md, Inspect project context, or Inspect one context file before relying on persistent personality or project instructions.
- Notes -> Create notes for source triage, temporary decisions, and operator handoff.
- Personas -> Inspect, create, show, or import VIBE.md; create, inspect, activate, review, stale, or delete personas.
- Skills -> Create, enable/disable, review, bundle, or delete.
- Routines -> Create, start in chat, review receipts, or explicitly promote to a connected schedule.
- Work -> Add work item, review work plan, and update status.

Starting a routine records local usage and prints its steps in the main conversation. Promotion to a connected schedule or automation job is separate, explicit, confirmation-gated, visible in the autonomy queue, and keeps Agent Knowledge isolated. When the user asks for recurring autonomous work directly, use `schedule action:"create"` to create one connected schedule only with explicit task, cadence, success criteria, confirmation, and user request provenance; use `schedule action:"remind"` for reminders and `schedule action:"pause|resume|run|delete"` for exact-id lifecycle controls. Confirmed schedule creation, routine promotion, reminders, edits, and lifecycle actions return next routes for schedule list, autonomy queue inspection, run, edit, pause, resume, and delete when applicable.

## Knowledge and artifacts

Use Agent Workspace -> Knowledge for source-backed Agent Knowledge. The valid connected-host route family is:

```text
/api/goodvibes-agent/knowledge/*
```

Agent commands fail closed if the route is unavailable or a successful-looking response carries non-Agent contamination. Parseable public Agent-route scope aliases are normalized before rendering.

The Knowledge workspace also exposes route-backed and command-backed workflows for issue review, prompt packet previews, context-selection explain output, consolidation, and reindex. Read-only ask/search/list/get/map/connector/packet/explain paths do not require mutation confirmation. Ingest, review-issue, consolidation, and reindex paths require explicit confirmation.

Use Agent Workspace -> Research for read-only web research, URL inspection, visible checkpointable research run state, a read-only Research briefing queue, bounded public source-candidate search, certified live SDK/daemon browser-runner and visual-report render evidence when published, project-local source queue review, reviewed-source bundles, saved report inspection, and confirmed sourced report artifacts. Research requests do not ingest sources.

The Research workspace shows browser-runner and visual-report readiness, the direct `research` run/source/report routes, a Research briefing action for `research action:"briefing"`, a Plan workflow action for `research action:"plan"`, a Public source search action for `research action:"search"`, a Browser runner readiness action for `research action:"runner"`, and a Report artifacts action for `research action:"reports"`.

Use `research action:"briefing"` first when the model needs one read-only next-action queue across visible runs, source review, saved report artifacts, certified live runner/render evidence, browser readiness, and exact follow-up routes. Use `research action:"search"` for one bounded public web search that returns capture-ready source candidates plus exact confirmed `add_source` routes; pass `runId` to use an existing visible run's saved question and receive run-specific start/checkpoint follow-up routes. It does not create runs or write source records by itself.

Use `research action:"runner"` for the direct browser-backed runner readiness contract and setup/fallback routes. Use `research action:"plan"` when the model needs one ordered route plan for a research request or existing run; it returns visible-run, source-collection, source-review, visual-report-save, and Knowledge-promotion steps plus browser-runner and visual-report packet contracts without performing any of them.

Research run records keep the user-facing question, phase, progress, checkpoints, log tails, source ids, next steps, confirmed lifecycle routes, certified live browser-runner records with schema/version/publication/publisher/provenance/freshness-cursor/receipt evidence, redacted current URLs/logs, source/page receipt ids, and runner posture that tells the model whether browser-backed research is ready, needs setup review, or should fall back to public web/fetch routes without starting hidden background work.

Research run detail and mutation outputs include next-route packets for inspect, briefing, workflow, run-bound search, source queue, checkpoint, report save, artifact inspection, and Knowledge promotion when a report artifact exists. The browser-runner contract names the required visible run controls, source-capture receipts, bounded logs, report handoff, setup routes, fallback routes, and certified read-model evidence before live browser execution is treated as ready.

Source queue records keep credibility, score, report-ready source lines, source bundle handoffs, and safe routes; source detail and mutation outputs point to the next review, reject, bundle, report, mark-used, artifact inspection, or optional Knowledge promotion route without performing those effects. Saved report artifacts keep a source map, citation coverage metadata, repair hints, optional strict body-citation enforcement, optional `visualReport:true` packet sections for at-a-glance summary, evidence matrix, findings board, dated source/comparison view, open questions, next actions, and handoff checklist, and next-route packets for report inspection, artifact export/archive, Knowledge promotion, report listing, and visible run completion when `runId` is supplied.

Use `research action:"report_artifact" artifactId:"..."` to inspect one saved report before export, archive, share, or Knowledge promotion. The visual-report contract names required sections, citation/source-map acceptance criteria, report save, review-packet, ZIP archive routes, and certified browser/PWA render read models with render route, redacted render URL, source-map count, citation coverage, visual sections, publication, and receipt evidence so richer rendering stays tied to the same reviewed artifacts. Use confirmed Agent Knowledge ingest actions when a reviewed source should become durable.

Use Agent Workspace -> Documents & Compare when a document needs:

- a versioned markdown draft
- review comments
- AI suggestion review
- review status
- reviewer-ready document artifact export
- chronological review packet timeline with stale-preset attention
- guided review packet progress/routes/backtracking/final archive review/refreshed-preset lineage/share handoff
- reviewer-readiness preflight for unresolved comments/suggestions/source artifacts/comparison reveal/route decisions/handoff evidence
- inline readiness badges at export/archive/apply points
- packet-default prefill for the next export/handoff/archive/apply/leave-unchanged/save-preset/share form
- a saved packet preset for recurring evidence ids with freshness checks before reuse and confirmed refresh when newer matching evidence exists
- saved artifact attachment or insertion
- single-artifact export
- multi-artifact package directory or ZIP archive export
- prompt context
- source checks
- generated media artifacts
- reviewed artifact-to-Knowledge promotion
- saved text artifact reuse in blind comparison
- a confirmed blind model comparison with:
  - local review
  - side-by-side reviewer view
  - split-pane reviewer handoff diff with section jumps and recent-handoff defaults
  - judgment
  - confirmed route-decision receipts
  - task/document/benchmark-filtered analytics
  - synthesis
  - reviewer handoff artifacts
  - one-click reviewer handoff ZIP archives with matching route-decision receipt evidence
- confirmed packet share through `agent_review_packet_share` when the user wants to send an archive reference to a configured channel target

Use the Artifacts area and Voice & Media workspace for images, source files, generated media, and exported sessions. Generated media returns artifact ids and metadata, not inline base64.

## Connected host

Connect Agent to a GoodVibes daemon before using daemon-backed features. Agent expects:

```text
http://127.0.0.1:3421
```

Override for one launch:

```sh
goodvibes-agent --runtime-url http://host:port
```

Persistent shell/session override:

```sh
export GOODVIBES_AGENT_RUNTIME_URL=http://host:port
```

Host diagnostics:

- Agent Workspace -> Home -> Host compatibility
- Agent Workspace -> Home -> Doctor diagnostics
- Agent Workspace -> Home -> Review health
- `goodvibes-agent status --json`
- `goodvibes-agent doctor`
- `goodvibes-agent compat`

Model-visible diagnostics prefer `host action:"status|capabilities|capability|services|service|methods|method"`. Lower-level `service_posture`, `service_endpoint`, `connected_host`, `connected_host_status`, `connected_host_capability`, `daemon`, and `daemon_status` harness modes remain available for compatibility and detailed inspection. `agent_operator_method` can run read-only routes directly and write/admin routes only with `confirm:true` plus `explicitUserRequest`.

When no connected host is reachable, inspect `setup action:"item" setupItemId:"connected-host-readiness"` for the offline bootstrap plan. It returns user-run commands to verify Bun, install and trust the owning GoodVibes host package, verify host entrypoints, start the GoodVibes service, and reconnect Agent. Agent does not run those host install/start commands implicitly.

One bounded exception happens at boot: when the host is already installed on this machine but its service is stopped, Agent starts it once through the platform service manager, waits briefly for it to answer, and reports what it did. When the host auth token is missing or malformed on the local machine, use `setup action:"token" setupItemId:"connected-host-auth" confirm:true explicitUserRequest:"..."`; it uses the GoodVibes SDK pairing helper to create or repair `~/.goodvibes/daemon/operator-tokens.json`, preserves valid existing tokens, leaves environment tokens untouched, and returns only path/fingerprint metadata.

## Current product notes

Agent uses the GoodVibes terminal shell, renderer, input, fullscreen workspace, command registry, and release foundation. Use `execution action:"status"` before computer-work handoffs. Local read/edit/exec is the preferred route when the current workspace and permissions are sufficient, and Agent Workspace -> Work & Approvals shows local process supervision with tracked/running/completed counts, stdin/PTY/sudo parity, and Background processes / Process capabilities actions.

Local shell/edit routes advertise process monitor/live tail/tool inspector supervision. First-class `execution`, `terminal`, and `process` adapters expose `execution action:"status|route|history|record|processes|process_capabilities|process|recovery"`, `terminal(command, background:true)`, and `process(action:"list|poll|wait|log|kill|write")` over the same tracked ProcessManager lifecycle. `execution action:"capabilities|doctor|parity"` goes straight to the read-only process capability report, while `process action:"capabilities"` remains available for users already in the process lifecycle tool. Lower-level `mode:"execution_posture|execution_route|browser_control_route|background_processes|background_process|run_background_process|execution_history|execution_history_item|file_recovery|run_file_recovery"` routes remain available for compatibility and detailed inspection.

The process capability report probes SDK ProcessManager methods plus daemon terminal/PTY, session-input, and credential routes so unsupported interactive features are tied to exact contract evidence instead of stale assumptions. PTY remains unsupported until a typed interactive session contract exists, and background sudo prompts are blocked in favor of visible user-supervised escalation. `setup action:"item" setupItemId:"sudo-execution-posture"` exposes SUDO_PASSWORD presence only, `~/.goodvibes/.env` guidance, blocked background sudo/stdin password routes, and the foreground shell route without reading or returning raw password values.

`setup action:"status"` also exposes connected-host setup repair cards with live service probe evidence, token-safe auth posture, exact pairing route ids, confirmed local token provisioning, status, service posture, recommended diagnostic/status routes, and confirmed service install/start/restart routes that stay inspect-first until service status proves need, plus browser/desktop-control readiness with ready, attention, or setup-needed state, workflow cards, setup checklist, fallback routes, MCP review routes, and `computer action:"plan"` for selecting a browser navigation, screenshot/observation, or desktop-control workflow before any trusted live-control tool is invoked.

Visible subagents stay serial-by-default unless independent work materially helps the user. `agent_harness mode:"agent_orchestration"` exposes the live Agent manager, managed multi-agent plan milestones, per-agent plan cards, linked work-plan receipts, closeout review/update routes, remote-runner contracts/artifact trails, certified daemon/SDK live capture/export/closeout outcome records, and certified workspace/worktree isolation evidence with schema/version/publication/publisher/provenance/freshness-cursor/receipt metadata and missing-signal surfacing.

The same mode carries auto-attached remote artifact review routes matched by runner id, spawn/batch-spawn decision cards, templates, and exact `agent` list/inspect/message/wait/cancel routes; `mode:"agent_orchestration_agent"` inspects one visible agent record with its plan card.

Approved visible work-plan items can be converted into visible agents through confirmed `agent_work_plan action:"dispatch_agents"`; the route previews without spawning, then calls first-class `agent` spawn or batch-spawn, writes linked-agent receipts back to the plan, and returns next routes for orchestration, work-plan detail, agent inspect/wait/message/cancel, and closeout.

Delegation is reserved for isolation, parallelism, remote execution, separate worktrees, or user-requested delegated review. `delegation action:"status|routes"` exposes local-first, TUI handoff, delegated-review, remote-inspection, and hidden-fanout-blocked decision cards; `delegation action:"route"` rows show required fields, success evidence, status routes, and recovery routes, while lower-level `agent_harness mode:"delegation_posture|delegation_route"` remains available for detailed compatibility inspection. The confirmed `/delegate` and Agent Workspace handoff form preserve the original ask plus delegation reason, success criteria, workspace/worktree hint, priority, and explicit review intent.

The active autonomy policy is visible autonomy. Long-running work must have a user-readable task, status/progress, cancellation route, success criteria, and confirmation gates for external or daemon-mutating effects. Use `autonomy action:"intake"` to turn an ongoing-work request into the safest visible route and missing fields; webhook/event-trigger requests expose trigger workflow posture and route applicable incoming watcher setup to the published `watchers.create` operator method, with trusted source/scope, task or run target, success criteria, `confirm:true`, and `explicitUserRequest` required.

Confirmed autonomous schedule creation uses `schedule action:"create"`, and confirmed existing-schedule edits use `schedule action:"edit"` with read-only current-state diffs before confirmation. Inspect current autonomy cards with `autonomy action:"queue"` or one card with `action:"item"`; lower-level `agent_harness mode:"autonomy_intake|autonomy_queue|autonomy_queue_item"` remains available for detailed compatibility inspection.

Research runs, connected-host tasks, approvals, automation runs, schedules, and delegated subagents surface live records or exact orchestration routes with progress/status, source ids, next steps, log tails when available, task retry/output/correlation diagnostics, bounded redacted host task output route/preview descriptors, automation telemetry/delivery/route diagnostics, normalized available/unavailable controls with reasons, and exact inspect/checkpoint/pause/resume/cancel/approve/deny/retry/run/edit/enable/disable/delete routes where the owning surface supports them.

Schedule records also expose pause/resume aliases over daemon enable/disable lifecycle routes so the queue speaks in user intent instead of scheduler internals. Connected-host task cancel/retry stays on exact confirmed `agent_operator_method` routes, while `/tasks` remains inspection-only.

The autonomy queue also consumes SDK/daemon watcher run/source read models when they are published, including watcher run history, automation watcher runs, Gmail/email provider sources, bounded redacted watcher output chunks, source/checkpoint/correlation diagnostics, read-only provider-source inspect/refresh controls, and exact confirmed watcher controls only when the owning host publishes those routes.

The preferred model-facing schedule path is `schedule action:"list|create|remind|edit|run|pause|resume|delete"`. The lower-level `agent_autonomy_schedule`, `agent_reminder_schedule`, `agent_schedule_edit`, and `agent_operator_action` routes remain available for exact diagnostics and compatibility.

Security policy decisions are inspectable before execution. The route planner sends active permission or approval questions to `security action:"status"`, incident/finding/leaked-secret questions to `security action:"finding"`, and blocked-action or confirmation questions to `security action:"explain"` before any risky work is attempted. Use `security action:"explain" toolName:"<tool>" toolArgs:{...}` or lower-level `agent_harness mode:"policy_explain"` to see the Agent route guard, permission-mode prediction, typed-confirmation requirement, redacted argument preview, and exact follow-up routes for one model action. The explanation is read-only; final execution still uses the live safety guard, permission prompt, and owning tool confirmation.
