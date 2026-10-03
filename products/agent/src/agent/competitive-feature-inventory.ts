export type CompetitorId = 'openclaw' | 'hermes' | 'odysseus';

export type GoodVibesCompetitiveStatus = 'leading' | 'parity' | 'partial' | 'gap';

export type GoodVibesOwner = 'agent' | 'connected-host' | 'companion' | 'release';

export interface CompetitorFeatureSignal {
  readonly competitor: CompetitorId;
  readonly evidence: string;
}

export interface CompetitiveFeatureInventoryItem {
  readonly id: string;
  readonly userOutcome: string;
  readonly targetStandard: 'parity' | 'better';
  readonly bestInClassRequirement: string;
  readonly goodVibesStatus: GoodVibesCompetitiveStatus;
  readonly owners: readonly GoodVibesOwner[];
  readonly goodVibesNow: string;
  readonly nextMoves: readonly string[];
  readonly competitorSignals: readonly CompetitorFeatureSignal[];
}

export const COMPETITIVE_FEATURE_INVENTORY: readonly CompetitiveFeatureInventoryItem[] = [
  // ─── LEADING ──────────────────────────────────────────────────────────────
  // These items represent verifiable differentiators where GoodVibes does
  // something the three tracked competitors do not, or does it materially better.
  {
    id: 'review-first-safety-model',
    userOutcome: 'Every high-impact action requires a typed confirmation, has a visible queue, produces audit evidence, and can be cancelled or rolled back without killing capability.',
    targetStandard: 'better',
    bestInClassRequirement: 'All risky effects are confirmation-gated with visible scope, durable receipts, and plain-language rollback routes before any effect fires.',
    goodVibesStatus: 'leading',
    owners: ['agent', 'release'],
    goodVibesNow: 'GoodVibes ships a deliberate review-first autonomy posture: every confirmed action produces a typed receipt, visible work queues show pending and completed effects, the permission policy is inspectable via `security action:"status|finding|explain"`, and the release gate bans superlatives and requires plain-language evidence before any capability claim. No silent side effects are permitted, even background processes, channel sends, and connector reads have explicit confirmation boundaries. This is a product stance, not a gap: competitors offer faster autonomy by removing review steps; GoodVibes keeps review as a first-class surface so users can trust what the assistant did.',
    nextMoves: [
      'Reduce unnecessary friction for already-approved low-risk workflows while keeping the confirmation boundary for irreversible effects.',
      'Attach every autonomous task to audit logs, artifact receipts, and cancel/rollback affordances as new daemon-backed work surfaces ship.',
      'Keep the plain-language release gate and superlative ban enforced on every new docs or release-notes contribution.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw emphasizes sandboxed or full shell access as a user choice; no mandatory review-first posture for high-impact actions.' },
      { competitor: 'hermes', evidence: 'Hermes autonomous skill creation and self-improvement run without user review; agent writes skills during use without a staged confirmation boundary.' },
      { competitor: 'odysseus', evidence: 'Odysseus agents run bash/files/web/memory tools without a visible confirmation queue or typed receipt model.' },
    ],
  },
  {
    id: 'blind-model-comparison',
    userOutcome: 'The user can run the same prompt against multiple models without knowing which is which, then reveal results, record a judgment, and apply a confirmed route change, all from one workflow with durable artifacts.',
    targetStandard: 'better',
    bestInClassRequirement: 'Blind comparison produces a durable JSON artifact, a reviewer-ready side-by-side view, a confirmed winner apply route, and a leave-unchanged receipt, so every route decision has an evidence trail.',
    goodVibesStatus: 'leading',
    owners: ['agent'],
    goodVibesNow: 'Agent ships a confirmed blind comparison runner with delayed reveal, durable JSON comparison artifacts, saved review boards, split-pane reviewer handoff diffs with section-jump focus, saved judgment artifacts, task/document/benchmark-filtered preference analytics and cross-session synthesis, confirmed apply-winner route-decision receipts, confirmed leave-unchanged route-decision receipts, and one-click reviewer handoff ZIP archives that bundle comparison evidence, matching route-decision receipt bytes, README, and manifest ids. The review packet wizard surfaces these artifacts in a chronological timeline with preflight badges that flag unrevealed comparisons or hidden judgments before export or archive.',
    nextMoves: [
      'Extend blind compare to cover vision and multimodal prompts once the artifact store can hold image payloads without leaking model identity metadata.',
      'Surface per-route benchmark latency from saved local cookbook artifacts directly in the compare side-by-side so cost/latency tradeoffs are visible at judgment time.',
      'Keep the delayed-reveal gate enforced in any future browser/PWA surface that renders comparison artifacts.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw supports multiple model providers and failover but does not ship a blind comparison runner with delayed reveal or judgment artifact workflow.' },
      { competitor: 'hermes', evidence: 'Hermes supports multi-model and OpenRouter routing but does not expose a blind comparison runner or durable judgment artifacts for route decisions.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships a Compare workspace but does not enforce delayed reveal or produce signed route-decision receipt artifacts with rollback evidence.' },
    ],
  },
  {
    id: 'isolated-knowledge-with-provenance',
    userOutcome: 'The assistant answers from a knowledge space the user controls, every source has a provenance chain, and segments that fail provenance checks are closed off rather than silently falling back to the base model.',
    targetStandard: 'better',
    bestInClassRequirement: 'Agent Knowledge is isolated per workspace, every ingested source carries certified provenance, and the system fails closed when provenance is missing rather than silently falling back.',
    goodVibesStatus: 'leading',
    owners: ['agent'],
    goodVibesNow: 'Agent Knowledge lives exclusively at `/api/goodvibes-agent/knowledge/*` with no default knowledge fallback; every ingest operation produces a certified provenance record; segments that cannot be certified are blocked, not silently served. The `agent_knowledge` and `agent_knowledge_ingest` tools expose isolated per-workspace RAG with provenance inspection and confirmed promotion routes. The knowledge semantic self-improvement ledger (`memory action:"refinement|run_refinement"`) runs bounded refinement against explicit source and gap ids without exposing raw source text or silently promoting local memory.',
    nextMoves: [
      'Add provenance gap surfacing to the Knowledge workspace so users can see which segments are blocked and why before they affect an answer.',
      'Expose per-segment provenance status in the research-to-Knowledge promotion workflow so users can review source quality before ingest completes.',
      'Keep fail-closed behavior as new knowledge connectors ship; certify each connector provenance contract before enabling automatic ingest.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw knowledge surfaces are community and user-owned but do not document fail-closed provenance enforcement or per-segment certification.' },
      { competitor: 'hermes', evidence: 'Hermes uses FTS5 cross-session recall and vector search but does not enforce certified provenance or fail-closed segment blocking.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships persistent user-controlled memory but does not certify source provenance or enforce fail-closed segment behavior.' },
    ],
  },
  {
    id: 'document-review-packets',
    userOutcome: 'The user can produce a document, attach AI suggestions and model comparison results, package everything into a reviewer-ready artifact, and hand it off to a human reviewer with a single confirmed action.',
    targetStandard: 'better',
    bestInClassRequirement: 'Document review packets include versioned drafts, AI suggestions with accept/reject review, comparison evidence, route-decision receipts, a preflight readiness badge, and a one-click ZIP archive with README and manifest.',
    goodVibesStatus: 'leading',
    owners: ['agent'],
    goodVibesNow: 'Agent ships project-scoped versioned markdown drafts with browse/show/create/revise/review/comment/suggest/accept-suggestion/reject-suggestion/artifact-attach/artifact-insert/export, a chronological review packet timeline across documents/comments/AI suggestions/attachments/exports/comparisons/judgments/route-decision receipts/handoffs/archives, a guided review packet wizard with progress/backtracking/preflight badges/refreshed-preset lineage, confirmed reviewer handoff artifacts bundling comparison evidence with related document exports and matching route-decision receipt bytes, one-click reviewer handoff ZIP archives, and confirmed `agent_review_packet_share` delivery through configured channel targets after explicit confirmation.',
    nextMoves: [
      'Certify real reviewer packet delivery outcomes across configured channel targets before claiming release-depth external delivery.',
      'Carry the packet wizard, lineage, and archive-share workflow into future browser/PWA surfaces without weakening confirmation or ZIP-byte boundaries.',
      'Add structured diff views for accept/reject suggestion batches so reviewers can see document state before and after a full suggestion pass.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw canvas provides visual interaction but does not ship a structured document review packet workflow with preflight badges or ZIP handoff artifacts.' },
      { competitor: 'hermes', evidence: 'Hermes supports conversation and session artifacts but does not ship a reviewer handoff packet workflow with versioned drafts, AI suggestion review, and route-decision receipt artifacts.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships a Documents workspace but does not produce reviewer handoff packets, preflight readiness badges, or one-click ZIP archives with manifests.' },
    ],
  },
  {
    id: 'profiles-as-starter-templates',
    userOutcome: 'The user can set up an isolated assistant home with a personality file, pre-loaded skills, and a channel configuration in one step by applying a starter template, without needing to understand underlying registry plumbing.',
    targetStandard: 'better',
    bestInClassRequirement: 'Profiles are isolated agent homes that can be exported, imported, shared as templates, and applied without ceremony or hidden side effects.',
    goodVibesStatus: 'leading',
    owners: ['agent'],
    goodVibesNow: 'GoodVibes ships Profiles as isolated Agent homes with starter templates. The VIBE.md opt-in import/export lets users start with a friendly personality file without persona-registry ceremony. Setup wizard history records stable timestamped entries per profile. Profile starter export/import/application is confirmed and preview-gated. This pattern, isolated homes with shareable starter bundles, is not present in any of the three tracked competitors at the agent-home isolation level.',
    nextMoves: [
      'Add a profile gallery or catalog so users can discover and apply community starter templates from within the setup wizard.',
      'Extend profile export to include the full channel configuration and permission posture so a shared profile is fully reproducible.',
      'Surface profile isolation boundaries in the onboarding flow so users understand what is shared across profiles and what is not.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw has per-account agent isolation via the Gateway but does not expose shareable starter templates for isolated agent homes.' },
      { competitor: 'hermes', evidence: 'Hermes exposes skill and memory customization but does not ship isolated agent homes with starter template export/import.' },
      { competitor: 'odysseus', evidence: 'Odysseus has a single workspace per install; no isolated profile homes or starter template workflow.' },
    ],
  },
  {
    id: 'honest-release-gates',
    userOutcome: 'The user can inspect exactly what was verified before a release shipped, see which checks passed or failed, and trust that no superlative or unverified claim was allowed through.',
    targetStandard: 'better',
    bestInClassRequirement: 'Every release carries a signed readiness inventory, a live verification ledger with pass/fail counts, a performance snapshot, and a plain-language gate that bans superlatives and requires evidence-backed claims.',
    goodVibesStatus: 'leading',
    owners: ['release'],
    goodVibesNow: 'GoodVibes ships a release readiness inventory (`release/release-readiness.json`) with schema-versioned items, a live verification JSON+Markdown report pair (`release/live-verification/`), a performance snapshot (`release/performance-snapshot.json`), and a plain-language gate that rejects superlatives, over-budget catalog summaries, and unverified harness mode references before release. The package-verification tooling enforces all of these at CI time. The release gate is itself versioned and can be audited. No tracked competitor publishes a comparable structured release evidence contract.',
    nextMoves: [
      'Keep live verification counts and performance snapshot budgets current as new runtime surfaces ship to prevent silent budget drift.',
      'Add a release gate check for docs files that reference stale or unregistered slash commands to catch command-name drift before it reaches users.',
      'Publish the release readiness schema publicly so downstream integrators can verify agent package releases programmatically.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw publishes GitHub releases and changelogs but does not ship a structured release readiness inventory or live verification ledger with the package.' },
      { competitor: 'hermes', evidence: 'Hermes ships a one-line installer but does not publish a structured release evidence contract or live verification pass/fail ledger.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships with a no-telemetry pledge but does not include a machine-readable release readiness inventory or plain-language gate artifact.' },
    ],
  },

  // ─── PARITY ───────────────────────────────────────────────────────────────
  // GoodVibes ships these capabilities at a level comparable to the tracked
  // competitors. No verifiable lead; no significant gap.
  {
    id: 'one-assistant-mental-model',
    userOutcome: 'The user asks one assistant for help and does not need to understand package, host, daemon, or execution-boundary ownership.',
    targetStandard: 'better',
    bestInClassRequirement: 'Every setup, chat, automation, channel, and execution route is presented as one assistant with visible safety and recovery state.',
    goodVibesStatus: 'parity',
    owners: ['agent', 'connected-host', 'companion'],
    goodVibesNow: 'Agent has a strong operator workspace with assistant-first lanes (setup, chat/model, project work, Personal Ops, research/docs, background work, safety/recovery), a route planner that accepts plain user tasks and returns preferred routes without exposing package-ownership language, and first-class adapters for host/daemon health, settings, models, Personal Ops, schedules, execution, memory, research, channels, security, support, sessions, and audit that all share one assistant surface. All three tracked competitors also present a unified assistant model to the user.',
    nextMoves: [
      'Keep adding plain-language route fixtures for any user task that still surfaces technical ownership language in the planner output.',
      'Promote new daemon and SDK contracts into first-class Agent routes only after they have visible status, confirmation, and recovery semantics.',
      'Audit new workspace lanes at each release to ensure no lane requires the user to understand GoodVibes package topology.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw presents Gateway as a control plane; the assistant product is the user-facing surface, not the topology.' },
      { competitor: 'hermes', evidence: 'Hermes exposes one assistant conversation model across CLI, gateway, and messaging surfaces.' },
      { competitor: 'odysseus', evidence: 'Odysseus bundles chat, agents, email, calendar, and documents into one web workspace with a single assistant entry point.' },
    ],
  },
  {
    id: 'first-run-and-always-on-setup',
    userOutcome: 'A fresh user can install, configure models, start the always-on runtime, and reach the assistant without manual topology work.',
    targetStandard: 'better',
    bestInClassRequirement: 'One guided flow verifies dependencies, installs or starts the host, configures auth, pairs channels, and leaves a working assistant.',
    goodVibesStatus: 'parity',
    owners: ['agent', 'connected-host', 'release'],
    goodVibesNow: 'Agent ships a setup wizard that orders connected-host readiness, auth, provider/model access, install smoke, local model readiness, Agent Knowledge, behavior, channels, Browser/PWA readiness, automation review, browser/desktop control, delegation, and finish state, with progress, current-step route hints, backtracking, and saved checkpoints that resume across restarts. Setup receipt artifacts auto-advance matching rows. All three tracked competitors also ship guided first-run flows that handle runtime dependencies and assistant configuration.',
    nextMoves: [
      'Keep per-step setup receipt schemas aligned with any new SDK/daemon first-run receipt versions before release evidence accepts them.',
      'Add real connected-host CI fixtures for ordered setup receipt event streams once the daemon publishes stable stream snapshots outside unit tests.',
      'Verify that the setup wizard correctly handles every new channel adapter as it ships to prevent silent channel-pairing gaps at first run.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw onboarding installs the Gateway daemon so it stays running and walks through model and channel configuration.' },
      { competitor: 'hermes', evidence: 'Hermes ships a one-line installer that handles runtime dependencies, a setup wizard, and gateway configuration.' },
      { competitor: 'odysseus', evidence: 'Odysseus Docker and native setup generate an admin account and open a local web UI ready for first use.' },
    ],
  },
  {
    id: 'autonomous-schedules-and-background-work',
    userOutcome: 'The user can ask for ongoing work in natural language and then supervise, pause, resume, or cancel it from a clear queue.',
    targetStandard: 'better',
    bestInClassRequirement: 'Schedules, cron jobs, recurring routines, and long-running tasks are autonomous but never hidden.',
    goodVibesStatus: 'parity',
    owners: ['agent', 'connected-host'],
    goodVibesNow: 'Agent has a first-class `schedule` adapter for list/create/remind/edit/run/pause/resume/delete, confirmed schedule creation, routine promotion, connected schedule editing with before/after diffs, and allowlisted lifecycle controls. The read-only autonomy queue maps visible owners, status, inspect routes, live research runs, connected-host task records, approval records, automation run records, schedule records, and delegated subagent orchestration routes with exact confirmed controls. All three tracked competitors also offer background task scheduling and autonomous background work.',
    nextMoves: [
      'Add live connected-host verification artifacts from real daemon watcher source streams as soon as CI can publish a stable GoodVibes daemon fixture.',
      'Broaden provider-specific watcher source fixtures beyond Gmail/email as the SDK and daemon publish additional source-owned watcher families.',
      'Surface active and completed schedule run history in the Home cockpit so users can see what the assistant did while they were away without drilling into the queue.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw supports cron, wakeups, webhooks, Gmail triggers, and always-on gateway workflows.' },
      { competitor: 'hermes', evidence: 'Hermes has a built-in cron scheduler for daily reports, backups, audits, and unattended work.' },
      { competitor: 'odysseus', evidence: 'Odysseus notes, tasks, reminders, and cron-style scheduled tasks can be acted on autonomously by the agent.' },
    ],
  },
  {
    id: 'computer-use-browser-and-shell',
    userOutcome: 'The assistant can browse, use the computer, run shell commands, edit files, and recover from mistakes with understandable approvals.',
    targetStandard: 'better',
    bestInClassRequirement: 'Computer use includes browser control, shell, files, code edits, desktop/device actions, sandboxing, undo, and live tool cards.',
    goodVibesStatus: 'parity',
    owners: ['agent', 'connected-host', 'companion'],
    goodVibesNow: 'Agent exposes local-first execution posture for read/search/analyze, file edit/write, bounded foreground shell commands, Work workspace process supervision with stdin/PTY/sudo parity, visible process monitor/live tail/tool inspector supervision routes, first-class `execution`, `computer`, `terminal`, and `process` adapters, certified SDK/daemon interactive runtime read models, and confirmed file recovery. All three tracked competitors also ship browser control, shell access, and file tools.',
    nextMoves: [
      'Keep certified interactive runtime schema fixtures current as SDK/daemon process, PTY, sudo, and browser-control contracts add fields.',
      'Add connected-host CI coverage for real daemon interactive runtime streams and browser/desktop command receipts when stable fixtures are available.',
      'Keep delegation for isolation, parallelism, or remote execution positioned as a tool choice, not the default answer to any computer-use ask.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw provides browser control, canvas, nodes, system.run, camera, screen recording, and session tools.' },
      { competitor: 'hermes', evidence: 'Hermes includes six terminal backends (local, Docker, SSH, Daytona, Singularity, Modal), browser tools, code execution, and isolated subagents.' },
      { competitor: 'odysseus', evidence: 'Odysseus agents use web, files, shell, MCP, skills, and memory tools via the opencode integration.' },
    ],
  },
  {
    id: 'deep-research-and-knowledge-reports',
    userOutcome: 'The user can ask for deep research and receive a sourced, inspectable report that can be saved to knowledge.',
    targetStandard: 'better',
    bestInClassRequirement: 'Research plans, source quality, citations, synthesis, visual report output, and knowledge ingest are one coherent workflow.',
    goodVibesStatus: 'parity',
    owners: ['agent', 'connected-host'],
    goodVibesNow: 'Agent has a Research workspace with browser-runner readiness, a project-local visible run ledger with checkpoint/pause/resume/cancel, bounded public source-candidate search, confirmed source collection with queue records, a reviewed-source bundle handoff, sourced report artifacts with citation coverage repair hints, and visual report packets with evidence matrix, findings board, and dated source/comparison views. Odysseus ships a comparable Deep Research workflow, and all three competitors have web tools, session search, and research-ready batch capabilities.',
    nextMoves: [
      'Keep live research runner and visual report renderer certification fixtures current as SDK/daemon read models add fields.',
      'Add connected-host CI coverage for real browser-backed research runs, page/source receipts, rendered report routes, and failure states when stable daemon fixtures publish them.',
      'Add a research source credibility scoring display to the source review queue so users can see provenance quality before adding a source to a report.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw showcases web research, bookmarks, project research, and personal knowledge workflows.' },
      { competitor: 'hermes', evidence: 'Hermes has web tools, session search, trajectory tooling, and research-ready batch workflows.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships Deep Research that gathers, reads, and synthesizes sources into a visual report, functionally comparable to GoodVibes research workflow.' },
    ],
  },

  // ─── PARTIAL ──────────────────────────────────────────────────────────────
  // GoodVibes ships meaningful capability here but has a documented gap
  // relative to one or more competitors. Each item has a concrete nextMove.
  {
    id: 'models-and-local-model-cookbook',
    userOutcome: 'The user can choose cloud, subscription, or local models without knowing provider-specific setup details, and the assistant recommends the best local model for their hardware.',
    targetStandard: 'better',
    bestInClassRequirement: 'Model setup recommends the best available route, detects local servers, benchmarks fit, detects hardware, and can help download or serve local models from a hardware-aware catalog.',
    goodVibesStatus: 'partial',
    owners: ['agent', 'connected-host'],
    goodVibesNow: 'GoodVibes ships first-class `models action:"status|route|local|providers|provider|smoke"` UX with hardware-scored local model cookbook for Ollama, llama.cpp, vLLM, and local OpenAI-compatible servers; CPU/RAM/platform scanning; safe accelerator hints; ranked fit; setup plans with download/start guidance; confirmed local smoke checks; saved benchmark-evidence review; and revealed winner judgments. The cookbook scans local platform and applies fit scores but does not auto-detect GPU model, VRAM, and supported quantization levels to recommend from a 270+ model catalog the way Odysseus does.',
    nextMoves: [
      'Add GPU/VRAM detection to the local cookbook hardware scan so quantization tier recommendations are accurate without user research.',
      'Expand the local model catalog beyond Ollama/llama.cpp/vLLM to cover additional serving backends that the daemon can manage.',
      'Publish hardware sizing guidelines in the cookbook output so users on constrained hardware get explicit guidance before a slow download.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw supports multiple model providers plus subscription auth and model failover, but does not ship a hardware-aware local cookbook.' },
      { competitor: 'hermes', evidence: 'Hermes supports many providers, OpenRouter, local endpoints, and a managed tool gateway subscription, but does not ship a hardware-scanning cookbook.' },
      { competitor: 'odysseus', evidence: 'Odysseus scans hardware for GPU/VRAM and recommends or serves models through Ollama, llama.cpp, and vLLM from a 270+ model catalog with one-click serving.' },
    ],
  },
  {
    id: 'omnichannel-inbox-and-delivery',
    userOutcome: 'The assistant is reachable where the user already communicates and can reply safely on those channels.',
    targetStandard: 'better',
    bestInClassRequirement: 'Channel setup is guided, inbound trust is default-safe, delivery is reliable, inbound messages route to isolated agent profiles, and the user can inspect every route from one place.',
    goodVibesStatus: 'partial',
    owners: ['agent', 'connected-host', 'companion'],
    goodVibesNow: 'GoodVibes ships approximately 11 channel adapters (ntfy, Slack, Discord, webhook, Telegram, Google Chat, home automation, Signal, WhatsApp, iMessage + telephony/Twilio), guided setup, readiness inspection, policy, confirmed send routes, and first-class `channels action:"status|channel|setup|triage|deliveries"` UX. Channel breadth (11) is materially narrower than OpenClaw (24+ channels) and Hermes (7 channels plus email). GoodVibes does not ship channel-to-isolated-profile routing: OpenClaw routes inbound channels to isolated agents with own workspaces via the local Gateway control plane.',
    nextMoves: [
      'Promote provider-specific unread channel inbox polling only when the connected-host contract publishes a general safe message feed.',
      'Certify real delivery outcomes per channel before claiming release readiness for any new adapter.',
      'Design a channel-to-profile routing contract so inbound messages can be directed to a specific isolated agent home without requiring manual session switching.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw ships 24+ channels (WhatsApp, Telegram, Slack, Discord, Google Chat, Signal, iMessage, IRC, Teams, Matrix, Feishu, LINE, Mattermost, Nextcloud Talk, Nostr, Synology Chat, Tlon, Twitch, Zalo, WeChat, QQ, WebChat, macOS, iOS, Android) plus channel-to-isolated-agent routing via the Gateway control plane.' },
      { competitor: 'hermes', evidence: 'Hermes supports Telegram, Discord, Slack, WhatsApp, Signal, CLI, and email from one gateway; no isolated-profile routing documented.' },
      { competitor: 'odysseus', evidence: 'Odysseus uses browser, email, ntfy, and mobile/PWA surfaces; narrower channel breadth than OpenClaw.' },
    ],
  },
  {
    id: 'closed-learning-loop',
    userOutcome: 'The assistant gets better over time by saving useful memories, skills, and routines only when they are useful and reviewable.',
    targetStandard: 'better',
    bestInClassRequirement: 'Learning is automatic enough to be useful, but every durable behavior has provenance, review, rollback, and quality scoring.',
    goodVibesStatus: 'partial',
    owners: ['agent'],
    goodVibesNow: 'Agent ships local memory, notes, personas, skills, routines, learned-behavior capture, safe VIBE.md personality discovery, project context injection with secret-content scanning, a learning curator with score-driven prompt plans, ranked review/stale/consolidation candidates, confirmed duplicate-consolidation phases, and formal promotion gating at or above the durable confidence threshold. Learning is review-first by design: behaviors do not become durable without user confirmation. Hermes and OpenClaw ship fully autonomous skill creation, agents write reusable skills during use without a staged confirmation boundary, and Hermes also ships skill self-improvement and the agentskills.io open standard for cross-agent skill sharing. GoodVibes is deliberately divergent here, but the divergence does cost autonomy speed.',
    nextMoves: [
      'Ship skill-standard import/export (agentskills.io-compatible) so review-first skills can still be shared and discovered across agents, see skill-standard-interop item.',
      'Add a fast-path confirmation mode for low-risk skill additions that have already been reviewed in a prior session to reduce ceremony without removing review.',
      'Keep Honcho, Mem0, Supermemory, and similar provider schema fixtures current as SDK/daemon contracts add provider-owned receipt fields.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw ships a community skills marketplace and agents can write their own skills; skill creation does not require a staged user review boundary.' },
      { competitor: 'hermes', evidence: 'Hermes markets autonomous skill creation (agent writes reusable skill docs when it solves hard problems), skill self-improvement during use, and agentskills.io open standard compatibility for cross-agent skill sharing.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships persistent memory and skills backed by vector and keyword retrieval; no autonomous skill creation described.' },
    ],
  },
  {
    id: 'multi-agent-and-remote-execution',
    userOutcome: 'Large tasks can be split safely across isolated agents or remote runners while the user sees progress and can intervene.',
    targetStandard: 'better',
    bestInClassRequirement: 'Parallelism is available when it improves time-to-result, with per-task workspaces, logs, artifacts, and review gates.',
    goodVibesStatus: 'partial',
    owners: ['agent', 'connected-host'],
    goodVibesNow: 'GoodVibes ships `agent_orchestration` and `agent_orchestration_agent` for visible subagent records, serial-by-default policy, managed milestones, per-agent plan cards with cancel/message/wait routes, remote-runner contract/artifact evidence, and durable remote closeout receipt evidence. Execution backends are local and connected-host only. Hermes ships six terminal backends (local, Docker, SSH, Daytona, Singularity, Modal) plus isolated subagents with own conversation and terminal; GoodVibes currently has no Docker/SSH/cloud terminal backend.',
    nextMoves: [
      'Keep remote-runtime outcome and workspace certification fixtures current as SDK/daemon read models add fields.',
      'Add connected-host CI coverage for real remote capture/export/closeout streams and workspace lifecycle controls when stable daemon fixtures publish them.',
      'Design the remote execution backend contract so Docker and SSH backends can be added through the connected-host operator method surface.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw supports multi-agent routing and session tools for agent-to-agent coordination.' },
      { competitor: 'hermes', evidence: 'Hermes spawns isolated subagents with own conversation and terminal, and supports six terminal backends: local, Docker, SSH, Daytona, Singularity, and Modal.' },
      { competitor: 'odysseus', evidence: 'Odysseus lets users hand tools to an agent and have it run whole tasks; any MCP server can be attached as a tool backend.' },
    ],
  },
  {
    id: 'mobile-voice-and-device-nodes',
    userOutcome: 'The user can talk to the assistant and use phone or desktop device capabilities without returning to the terminal.',
    targetStandard: 'better',
    bestInClassRequirement: 'Voice, mobile, notifications, wake word, talk mode, camera, screen, location, and device commands are paired, permission-aware, and reliable.',
    goodVibesStatus: 'partial',
    owners: ['agent', 'connected-host', 'companion'],
    goodVibesNow: 'Agent ships `device action:"status|capability|voice|provider|open_tts_provider|open_tts_voice"` UX over companion pairing, mobile/PWA compatibility, voice/TTS, notifications, TTS provider/voice picker, and `computer action:"status|plan|control|browser|setup"` for browser/PWA readiness and desktop-control workflow planning. TTS, image input, and media generation are shipped. A wake word is shipped and listening on this surface: `voice.wake.enabled` plus `voice.wake.surfaces.agent` opens a recorder subprocess on the host, scores every 80 ms frame against the pinned "hey goodvibes" classifier, plays an activation sound, shows a persistent listening row in the footer, and sends the utterance that follows to speech-to-text, into the conversation input, or submitted outright with `voice.wake.autoSubmit`. Its delivery row is off by default because two terminal surfaces acting on one spoken utterance is a confusing default, and its published recall figures are measured on synthesised speech only. No Talk Mode (continuous conversation) is available. OpenClaw ships voice wake words on macOS/iOS and a continuous Talk Mode on Android via ElevenLabs and system TTS.',
    nextMoves: [
      'Extend wake-word capture to a companion platform (macOS or Android), the host surfaces listen, a phone in the user\'s pocket does not.',
      'Design a continuous Talk Mode that integrates TTS output with push-to-talk input into a single conversation loop with latency-aware turn detection.',
      'Keep companion device capability certification fixtures current as SDK/daemon records add camera, screen, location, notification, wake, and device-command fields.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw ships wake words on macOS/iOS and a continuous Talk Mode on Android with ElevenLabs and system TTS integration.' },
      { competitor: 'hermes', evidence: 'Hermes runs in Termux and supports voice memo transcription and messaging continuity; no wake word or talk mode documented.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships a responsive PWA with mobile support and browser notifications; no voice wake word or talk mode documented.' },
    ],
  },
  {
    id: 'web-dashboard-and-pwa',
    userOutcome: 'The assistant is usable from a browser with clear status, settings, sessions, tools, and mobile-friendly controls.',
    targetStandard: 'better',
    bestInClassRequirement: 'The browser surface is not a secondary admin panel; it is a full user-grade assistant cockpit.',
    goodVibesStatus: 'partial',
    owners: ['connected-host', 'agent'],
    goodVibesNow: 'GoodVibes ships a TUI as the primary interface and a browser cockpit/PWA route accessible through `computer action:"browser|open_browser"` once connected-host publishes certified browser-native category routes and first-run receipts. Agent reports workspace-category coverage and mobile/PWA controls when the SDK/daemon certifies the route. The PWA surface is partial: Odysseus primary experience is a self-hosted responsive web workspace; OpenClaw serves a Control UI, WebChat, and companion apps from the Gateway. GoodVibes does not yet have a standalone desktop or web app shell.',
    nextMoves: [
      'Keep certified browser/PWA category-route and first-run receipt schemas in lockstep with SDK/daemon contract versions.',
      'Add live connected-host browser/PWA acceptance artifacts to every stable-release verification run.',
      'Clarify the roadmap for a standalone desktop app so users who cannot use the TUI have a documented path to first-class access.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw Gateway serves a Control UI, WebChat surface, and companion apps for macOS, iOS, and Android.' },
      { competitor: 'hermes', evidence: 'Hermes provides a local web dashboard surface in addition to TUI; it left the terminal-only era with an official desktop app.' },
      { competitor: 'odysseus', evidence: 'Odysseus primary experience is a self-hosted responsive web workspace/PWA with no mandatory TUI dependency.' },
    ],
  },
  {
    id: 'skill-standard-interop',
    userOutcome: 'Skills created in GoodVibes can be shared with other agents, and skills created by the community or other agents can be imported into GoodVibes.',
    targetStandard: 'parity',
    bestInClassRequirement: 'Skills follow an open standard format so they are portable across agents and discoverable from a community index.',
    goodVibesStatus: 'partial',
    owners: ['agent'],
    goodVibesNow: 'GoodVibes ships Agent-local skills with provenance, review gating, and confirmed promotion. Skill import/export in the agentskills.io open standard format is being built (active development as of this inventory). Hermes ships agentskills.io-compatible skill creation and sharing. OpenClaw has a community skills marketplace. GoodVibes does not yet have a community skill catalog or cross-agent import/export path.',
    nextMoves: [
      'Ship skill-standard import/export so GoodVibes skills can be shared with agentskills.io-compatible agents and imported from the community index.',
      'Add a skill discovery surface in the Agent workspace that shows community skills alongside local skills with provenance and review status.',
      'Design the review-first import gate for community skills: imported skills must go through the same confirmation boundary as locally created ones.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw ships a community skills marketplace and agents can write and publish their own skills.' },
      { competitor: 'hermes', evidence: 'Hermes ships agentskills.io open standard compatibility for cross-agent skill sharing and discovery.' },
      { competitor: 'odysseus', evidence: 'Odysseus does not document a skill marketplace or open skill standard; skills are built-in tool integrations.' },
    ],
  },

  // ─── GAP ──────────────────────────────────────────────────────────────────
  // GoodVibes does not ship the capability described here.
  // Each gap has concrete nextMoves that represent the build path to parity.
  {
    id: 'email-calendar-direct-access',
    userOutcome: 'The assistant can triage email, draft replies in the user\'s writing style, apply labels, access calendar events directly over IMAP/SMTP and CalDAV, and act on tasks and reminders.',
    targetStandard: 'better',
    bestInClassRequirement: 'Email triage, AI-matched draft replies, auto-tagging, spam triage, direct CalDAV calendar sync, .ics import/export, and agent-aware scheduling share one reviewed personal operations surface.',
    goodVibesStatus: 'partial',
    owners: ['agent', 'connected-host'],
    goodVibesNow: 'GoodVibes ships direct IMAP/SMTP email access and .ics calendar import/export, wired to the `/email` and `/calendar` agent routes. Personal Ops has a unified workspace and first-class `personal_ops action:"briefing|status|queue|intake|lane|read"` model tool. Email and calendar access is backed by direct protocol connectors and MCP connectors that surface inbox and calendar operations as inspectable setup routes with confirmed read and write boundaries. Writing-style-matched draft replies, auto-tagging, spam triage, and direct CalDAV server sync (Radicale/Nextcloud/Apple/Fastmail) are not yet shipped.',
    nextMoves: [
      'Design writing-style matching for draft replies as a confirmed Personal Ops lane so the assistant can draft in the user\'s voice with explicit before-send review.',
      'Add a CalDAV server sync connector (Radicale, Nextcloud, Apple Calendar, Fastmail) so local-first calendar changes propagate without a cloud calendar MCP service.',
      'Add auto-tagging and spam triage to the IMAP email connector so high-volume inboxes are manageable from the Personal Ops briefing surface.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw showcases mail, calendar, reminders, and personal operating-system workflows; channel breadth suggests direct protocol access.' },
      { competitor: 'hermes', evidence: 'Hermes messaging gateway includes email as a channel; Google Workspace skills imply calendar and mail access beyond connector mediation.' },
      { competitor: 'odysseus', evidence: 'Odysseus ships native IMAP/SMTP email with AI summaries, style-matched replies, auto-tagging, spam triage, and a local-first CalDAV calendar with Radicale/Nextcloud/Apple/Fastmail sync and .ics import/export.' },
    ],
  },
  {
    id: 'channel-to-profile-routing',
    userOutcome: 'When a message arrives on a specific channel or account, it is routed to the correct isolated agent profile automatically, so the assistant\'s context, permissions, and personality match the channel.',
    targetStandard: 'parity',
    bestInClassRequirement: 'Inbound channels and accounts route to isolated agents with their own workspaces and sessions via a local control plane.',
    goodVibesStatus: 'gap',
    owners: ['agent', 'connected-host'],
    goodVibesNow: 'GoodVibes ships isolated Profiles (Agent homes) and channel adapters, but inbound channel messages are not automatically routed to specific profiles. Users must switch profiles manually. OpenClaw routes inbound channels and accounts to isolated agents with own workspaces and sessions via the local Gateway control plane.',
    nextMoves: [
      'Design a channel-to-profile routing contract in the connected-host operator method surface so inbound messages can be directed to a named profile home.',
      'Add a channel routing configuration surface to the Channels workspace so users can assign each channel to a specific profile without manual session switching.',
      'Ensure the routing contract respects the review-first confirmation boundary: routing configuration changes require explicit user confirmation before taking effect.',
    ],
    competitorSignals: [
      { competitor: 'openclaw', evidence: 'OpenClaw routes inbound channels and accounts to isolated agents with own workspaces and sessions via the local Gateway multi-agent routing control plane.' },
      { competitor: 'hermes', evidence: 'Hermes routes Telegram, Discord, Slack, WhatsApp, Signal, CLI, and email through one gateway but does not document isolated per-channel agent profiles.' },
      { competitor: 'odysseus', evidence: 'Odysseus does not document channel-to-profile routing; single workspace per install.' },
    ],
  },
];

export function competitiveInventoryStatusCounts(): Record<GoodVibesCompetitiveStatus, number> {
  return COMPETITIVE_FEATURE_INVENTORY.reduce<Record<GoodVibesCompetitiveStatus, number>>((counts, item) => {
    counts[item.goodVibesStatus] += 1;
    return counts;
  }, {
    leading: 0,
    parity: 0,
    partial: 0,
    gap: 0,
  });
}
