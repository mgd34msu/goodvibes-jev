import { AGENT_HARNESS_MODES } from './agent-harness-tool-schema.ts';
import { catalogEnvelope, readLimit } from './agent-harness-tool-utils.ts';
import { catalogSearchTokens, searchCatalog, type CatalogSearchResult } from './agent-harness-catalog-search.ts';

export type AgentHarnessMode = typeof AGENT_HARNESS_MODES[number];

type HarnessModeKind = 'summary' | 'discover' | 'inspect' | 'effect' | 'alias';

interface HarnessModeDescriptor {
  readonly id: AgentHarnessMode;
  readonly kind: HarnessModeKind;
  readonly family: string;
  readonly summary: string;
  readonly next?: string;
  readonly requiresConfirmation?: boolean;
  readonly aliases?: readonly AgentHarnessMode[];
  readonly keywords?: readonly string[];
  readonly parameters?: readonly string[];
}

interface HarnessModeCatalogArgs {
  readonly query?: unknown;
  readonly target?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export type HarnessModeResolution =
  | { readonly status: 'found'; readonly mode: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export const HARNESS_MODE_DESCRIPTORS: readonly HarnessModeDescriptor[] = [
  { id: 'summary', kind: 'summary', family: 'start', summary: 'Compact harness map, counts, posture, and mode guide.', next: 'Use modes or a plural catalog mode to drill in.', parameters: ['includeParameters'] },
  { id: 'modes', kind: 'discover', family: 'start', summary: 'Search all agent_harness modes by task, family, effect, or id.', next: 'Use mode for one exact mode contract.', parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'mode', kind: 'inspect', family: 'start', summary: 'Inspect one agent_harness mode contract and common next step.', next: 'Use target or query with a mode id or task phrase.', parameters: ['target', 'query'] },
  { id: 'route_decision', kind: 'inspect', family: 'start', summary: 'Choose the best visible Agent route for a plain user task.', next: 'Prefer route action:"plan" for first-class access.', keywords: ['where should this go', 'which tool', 'route user task', 'one assistant', 'user-first route'], parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'cli_commands', kind: 'discover', family: 'cli', summary: 'List top-level package CLI mirrors for discovery only.', next: 'Prefer workspace action:"cli_commands|cli_command".', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'cli_command', kind: 'inspect', family: 'cli', summary: 'Inspect one CLI command parser result, policy, aliases, and model route.', parameters: ['cliCommand', 'command', 'commandName', 'target', 'query'] },
  { id: 'ui_surfaces', kind: 'discover', family: 'ui', summary: 'List modal, picker, and visible UI surfaces the model can request.', next: 'Prefer workspace action:"surfaces|surface|open".', keywords: ['web dashboard', 'pwa', 'browser cockpit', 'connected browser', 'mobile web'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'ui_surface', kind: 'inspect', family: 'ui', summary: 'Inspect one visible modal or picker surface and route contract.', keywords: ['web dashboard', 'pwa', 'browser cockpit', 'connected browser', 'mobile web'], parameters: ['surfaceId', 'target', 'query'] },
  { id: 'open_ui_surface', kind: 'effect', family: 'ui', summary: 'Open one visible modal, picker, or operator workspace route.', requiresConfirmation: true, keywords: ['web dashboard', 'pwa', 'browser cockpit', 'connected browser', 'mobile web'], parameters: ['surfaceId', 'target', 'query', 'confirm', 'explicitUserRequest'] },
  { id: 'shortcuts', kind: 'discover', family: 'keyboard', summary: 'List fixed shortcuts and keybinding overview.', next: 'Prefer workspace action:"shortcuts|keybindings|keybinding".', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'keybindings', kind: 'discover', family: 'keyboard', summary: 'List configurable keybinding actions and current/default combos.', next: 'Prefer workspace keybinding actions.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'keybinding', kind: 'inspect', family: 'keyboard', summary: 'Inspect one keybinding action, current combos, defaults, and policy.', parameters: ['actionId', 'key', 'target', 'query'] },
  { id: 'run_keybinding', kind: 'effect', family: 'keyboard', summary: 'Run one supported keybinding action through the active UI route.', requiresConfirmation: true, parameters: ['actionId', 'key', 'target', 'query', 'confirm', 'explicitUserRequest'] },
  { id: 'set_keybinding', kind: 'effect', family: 'keyboard', summary: 'Set one configurable keybinding action.', requiresConfirmation: true, parameters: ['actionId', 'combo', 'combos', 'confirm', 'explicitUserRequest'] },
  { id: 'reset_keybinding', kind: 'effect', family: 'keyboard', summary: 'Reset one configurable keybinding action to defaults.', requiresConfirmation: true, parameters: ['actionId', 'confirm', 'explicitUserRequest'] },
  { id: 'commands', kind: 'discover', family: 'slash', summary: 'List registered slash commands and compact policies.', next: 'Prefer workspace action:"commands|command|run_command".', keywords: ['payment card entry', 'credit card', 'enter card', 'guided flow', 'chained prompt'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'command', kind: 'inspect', family: 'slash', summary: 'Inspect slash command, parsed args, policy, aliases, and model route.', parameters: ['command', 'commandName', 'target', 'query'] },
  { id: 'run_command', kind: 'effect', family: 'slash', summary: 'Run one slash command through shared command dispatch.', requiresConfirmation: true, parameters: ['command', 'commandName', 'args', 'target', 'query', 'confirm', 'explicitUserRequest'] },
  { id: 'channels', kind: 'discover', family: 'delivery', summary: 'List channel readiness, accounts, delivery posture, and safe setup keys.', next: 'Prefer channels action:"status|channel|setup".', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'channel', kind: 'inspect', family: 'delivery', summary: 'Inspect one channel readiness entry and delivery policy.', next: 'Prefer channels action:"channel".', parameters: ['channelId', 'target', 'query'] },
  { id: 'channel_setup_guide', kind: 'inspect', family: 'delivery', summary: 'Inspect the ordered channel setup guide and current per-channel step.', next: 'Prefer channels action:"setup".', parameters: ['channelId', 'target', 'query'] },
  { id: 'channel_triage', kind: 'discover', family: 'delivery', summary: 'Triage blockers, retries, messages, routes, and receipts.', next: 'Prefer channels action:"triage".', keywords: ['inbox', 'triage', 'channel errors', 'delivery retries', 'pending messages', 'surface messages', 'route bindings'], parameters: ['limit', 'includeParameters'] },
  { id: 'channel_deliveries', kind: 'discover', family: 'delivery', summary: 'List recent redacted confirmed channel delivery receipts.', next: 'Prefer channels action:"deliveries".', keywords: ['delivery receipts', 'channel history', 'sent messages', 'send outcomes'], parameters: ['limit', 'includeParameters'] },
  { id: 'notifications', kind: 'discover', family: 'delivery', summary: 'List notification target posture with webhook values redacted.', next: 'Use notification_target or agent_notify.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'notification_target', kind: 'inspect', family: 'delivery', summary: 'Inspect one notification target and safe routing policy.', parameters: ['notificationTargetId', 'target', 'query'] },
  { id: 'provider_accounts', kind: 'discover', family: 'providers', summary: 'List provider auth, subscription, usage-window, and repair posture.', next: 'Prefer models action:"providers"; provider_account for detail.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'provider_account', kind: 'inspect', family: 'providers', summary: 'Inspect one provider account/auth posture without token leakage.', parameters: ['providerId', 'target', 'query'] },
  { id: 'mcp_servers', kind: 'discover', family: 'tools', summary: 'List MCP server/tool/security posture without exposing env or secrets.', next: 'Use mcp_server.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'mcp_server', kind: 'inspect', family: 'tools', summary: 'Inspect one MCP server, tools, schemas, auth, and trust posture.', parameters: ['mcpServerId', 'target', 'query'] },
  { id: 'setup_posture', kind: 'discover', family: 'setup', summary: 'Inspect first-run/always-on setup plan, posture, and flags.', next: 'Use setup_item.', keywords: ['sudo', 'sudo_password', 'SUDO_PASSWORD', 'pty', 'process write', 'credential posture'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'setup_item', kind: 'inspect', family: 'setup', summary: 'Inspect one first-run/always-on setup plan item.', keywords: ['sudo', 'sudo_password', 'SUDO_PASSWORD', 'pty', 'process write', 'credential posture'], parameters: ['setupItemId', 'target', 'query'] },
  { id: 'setup_repair', kind: 'inspect', family: 'setup', summary: 'Choose the safest next setup repair route.', next: 'Prefer setup action:"repair".', keywords: ['repair setup', 'fix setup', 'launch host', 'start host', 'daemon repair', 'service status receipt', 'bootstrap host'], parameters: ['setupItemId', 'target', 'query', 'includeParameters'] },
  { id: 'setup_checkpoint', kind: 'inspect', family: 'setup', summary: 'Inspect saved setup wizard checkpoint and current resume step.', parameters: ['includeParameters'] },
  { id: 'mark_setup_checkpoint', kind: 'effect', family: 'setup', summary: 'Save the current setup wizard step as the resume checkpoint.', requiresConfirmation: true, parameters: ['setupItemId', 'confirm', 'explicitUserRequest'] },
  { id: 'clear_setup_checkpoint', kind: 'effect', family: 'setup', summary: 'Clear the saved setup wizard checkpoint.', requiresConfirmation: true, parameters: ['confirm', 'explicitUserRequest'] },
  { id: 'provision_connected_host_token', kind: 'effect', family: 'setup', summary: 'Create or repair local connected-host token safely.', requiresConfirmation: true, parameters: ['setupItemId', 'confirm', 'explicitUserRequest'] },
  { id: 'run_setup_smoke', kind: 'effect', family: 'setup', summary: 'Run redacted first-run setup smoke evidence collection.', requiresConfirmation: true, parameters: ['setupItemId', 'fields', 'includeParameters', 'confirm', 'explicitUserRequest'] },
  { id: 'project_context', kind: 'discover', family: 'context', summary: 'List AGENTS, HERMES, CLAUDE, SOUL, and Cursor context files.', next: 'Prefer context action:"files|file".', keywords: ['agents.md', 'hermes.md', '.hermes.md', 'claude.md', 'soul.md', '.cursorrules', '.cursor/rules', 'project instructions'], parameters: ['target', 'query', 'includeParameters'] },
  { id: 'project_context_file', kind: 'inspect', family: 'context', summary: 'Inspect one project context file body, source, or blocked reason.', next: 'Prefer context action:"file".', keywords: ['agents.md', 'hermes.md', '.hermes.md', 'claude.md', 'soul.md', '.cursorrules', '.cursor/rules', 'project instructions'], parameters: ['contextFileId', 'target', 'query', 'includeParameters'] },
  { id: 'prompt_context', kind: 'inspect', family: 'context', summary: 'Inspect prompt context, receipt outcomes, and token budget.', next: 'Prefer context action:"prompt|receipts|receipt".', keywords: ['prompt context', 'system prompt', 'why assistant acts', 'selected memory', 'active persona', 'suppressed context', 'token budget', 'receipt id', 'turn outcome', 'prompt receipt filters'], parameters: ['receiptId', 'turnId', 'outcomeStatus', 'limit', 'includeParameters'] },
  { id: 'agent_orchestration', kind: 'discover', family: 'execution', summary: 'Inspect plan cards, closeout, live remote outcomes, and dispatch.', next: 'Inspect one agent; dispatch approved plan items via agent_work_plan.', keywords: ['subagent', 'subagents', 'agent spawn', 'batch-spawn', 'dispatch agents', 'work plan dispatch', 'dispatch receipts', 'closeout evidence', 'remote read model', 'capture outcome', 'workspace isolation', 'worktree evidence', 'multi-agent', 'multi-runner', 'managed plan', 'milestone', 'remote runner', 'artifact trail', 'visible agents', 'cancellable agents', 'wrfc', 'cohort'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'agent_orchestration_agent', kind: 'inspect', family: 'execution', summary: 'Inspect one visible Agent plan card with remote evidence.', keywords: ['subagent', 'subagents', 'agent status', 'agent cancel', 'agent wait', 'agent message', 'batch-spawn', 'dispatch receipts', 'closeout evidence', 'remote read model', 'capture outcome', 'workspace isolation', 'worktree evidence', 'multi-agent', 'multi-runner', 'managed plan', 'milestone', 'remote runner', 'artifact trail', 'visible agents', 'cancellable agents', 'wrfc', 'cohort'], parameters: ['agentId', 'target', 'query', 'includeParameters'] },
  { id: 'model_routing', kind: 'discover', family: 'providers', summary: 'List model routes, readiness scores, local cookbook, and pins.', next: 'Prefer models action:"status|local|route|smoke".', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'model_route', kind: 'inspect', family: 'providers', summary: 'Inspect one model route, local endpoint, fit score, or picker path.', parameters: ['modelRouteId', 'target', 'query'] },
  { id: 'run_local_model_smoke', kind: 'effect', family: 'providers', summary: 'Run confirmed read-only model-list smoke checks for local endpoints.', requiresConfirmation: true, keywords: ['local model smoke', 'check local servers', 'ollama models', 'local endpoint probe'], parameters: ['modelRouteId', 'target', 'query', 'limit', 'timeoutMs', 'confirm', 'explicitUserRequest'] },
  { id: 'execution_posture', kind: 'discover', family: 'execution', summary: 'Pick local shell/edit execution vs delegation.', next: 'Prefer execution action:"status"; use action:"route" for one.', keywords: ['sudo', 'sudo_password', 'SUDO_PASSWORD', 'foreground shell', 'privilege escalation'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'execution_route', kind: 'inspect', family: 'execution', summary: 'Inspect one local, browser, web, or delegation route.', next: 'Prefer execution action:"route".', keywords: ['sudo', 'sudo_password', 'SUDO_PASSWORD', 'foreground shell', 'privilege escalation'], parameters: ['executionRouteId', 'target', 'query'] },
  { id: 'browser_control_route', kind: 'inspect', family: 'execution', summary: 'Plan browser, screenshot, or desktop-control route.', next: 'Prefer computer action:"plan".', keywords: ['browser control plan', 'take screenshot', 'screen observe', 'desktop control', 'live ui control', 'browser navigation'], parameters: ['target', 'query', 'includeParameters'] },
  { id: 'background_processes', kind: 'discover', family: 'execution', summary: 'List tracked local background processes, logs, and lifecycle routes.', next: 'Prefer execution action:"processes"; use process for lifecycle effects.', parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'background_process', kind: 'inspect', family: 'execution', summary: 'Inspect one tracked background process with bounded output tails.', next: 'Prefer execution action:"process".', keywords: ['session id', 'process session', 'poll', 'log'], parameters: ['processId', 'processSessionId', 'sessionId', 'session_id', 'target', 'query', 'includeParameters'] },
  { id: 'run_background_process', kind: 'effect', family: 'execution', summary: 'Process lifecycle with poll/log/kill aliases and PTY/sudo gaps.', requiresConfirmation: true, keywords: ['process tool', 'session id', 'process session', 'poll', 'kill', 'write', 'log', 'pty', 'sudo'], parameters: ['processAction', 'action', 'processId', 'processSessionId', 'sessionId', 'session_id', 'command', 'cwd', 'timeoutMs', 'pty', 'data', 'fields', 'confirm', 'explicitUserRequest'] },
  { id: 'execution_history', kind: 'discover', family: 'execution', summary: 'List recent execution activity cards and raw records.', next: 'Prefer execution action:"history"; use action:"record" for one.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'execution_history_item', kind: 'inspect', family: 'execution', summary: 'Inspect one execution record with user card, routes, and recovery.', next: 'Prefer execution action:"record".', parameters: ['executionRecordId', 'recordId', 'target', 'query'] },
  { id: 'file_recovery', kind: 'discover', family: 'execution', summary: 'Inspect local file edit undo/redo recovery.', next: 'Prefer execution action:"recovery"; apply with confirmation.', parameters: ['includeParameters'] },
  { id: 'run_file_recovery', kind: 'effect', family: 'execution', summary: 'Apply one local file undo or redo snapshot.', requiresConfirmation: true, parameters: ['recoveryAction', 'target', 'query', 'confirm', 'explicitUserRequest'] },
  { id: 'personal_ops_briefing', kind: 'discover', family: 'personal-ops', summary: 'Build a daily briefing plan across Personal Ops and autonomy.', next: 'Prefer personal_ops action:"briefing".', keywords: ['daily brief', 'morning brief', 'operator brief', 'personal briefing', 'daily ops', 'personal operations'], parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'personal_ops', kind: 'discover', family: 'personal-ops', summary: 'Map email/calendar tasks, reminders, records, and operation cards.', next: 'Prefer personal_ops action:"status".', keywords: ['personal operations'], parameters: ['includeParameters'] },
  { id: 'personal_ops_queue', kind: 'discover', family: 'personal-ops', summary: 'List saved inbox/calendar review queues and fresh-read routes.', next: 'Prefer personal_ops action:"queue".', keywords: ['personal operations', 'inbox queue', 'email queue', 'calendar queue', 'agenda queue', 'saved review', 'daily ops'], parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'personal_ops_intake', kind: 'discover', family: 'personal-ops', summary: 'Plan personal requests to safe routes, fields, and confirmations.', next: 'Prefer personal_ops action:"intake".', keywords: ['personal operations', 'email calendar tasks reminders', 'email triage', 'inbox triage', 'draft reply', 'calendar briefing', 'agenda briefing', 'calendar conflicts', 'personal request', 'daily ops'], parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'personal_ops_lane', kind: 'inspect', family: 'personal-ops', summary: 'Inspect email/calendar tasks/reminders records, cards, and routes.', keywords: ['personal operations'], parameters: ['laneId', 'target', 'query'] },
  { id: 'run_personal_ops_read', kind: 'effect', family: 'personal-ops', summary: 'Run one confirmed read-only inbox/calendar MCP operation.', next: 'Prefer personal_ops action:"read" for user-facing calls.', requiresConfirmation: true, keywords: ['email triage', 'inbox read', 'calendar read', 'agenda read', 'mcp call tool'], parameters: ['laneId', 'recordId', 'target', 'query', 'fields', 'includeParameters', 'confirm', 'explicitUserRequest'] },
  { id: 'memory_posture', kind: 'discover', family: 'personal-ops', summary: 'Inspect Agent-local memory, vector recall, and provider posture.', next: 'Prefer memory action:"status"; use action:"provider" for one.', keywords: ['semantic recall', 'external memory', 'memory provider', 'honcho', 'openviking', 'mem0', 'hindsight', 'holographic', 'retaindb', 'byterover', 'supermemory'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'memory_provider', kind: 'inspect', family: 'personal-ops', summary: 'Inspect one memory embedding or external-memory provider record.', keywords: ['semantic recall', 'external memory', 'embedding provider', 'memory provider', 'honcho', 'openviking', 'mem0', 'hindsight', 'holographic', 'retaindb', 'byterover', 'supermemory'], parameters: ['providerId', 'target', 'query', 'includeParameters'] },
  { id: 'memory_refinement', kind: 'discover', family: 'personal-ops', summary: 'Inspect Knowledge semantic self-improvement tasks and routes.', next: 'Prefer memory action:"refinement".', keywords: ['semantic self improvement', 'semantic refinement', 'refinement tasks', 'closed learning loop', 'knowledge gaps', 'memory learning loop'], parameters: ['query', 'target', 'knowledgeSpaceId', 'sourceIds', 'gapIds', 'limit', 'includeParameters'] },
  { id: 'run_memory_refinement', kind: 'effect', family: 'personal-ops', summary: 'Run bounded Agent Knowledge semantic self-improvement.', next: 'Prefer memory action:"run_refinement".', requiresConfirmation: true, keywords: ['run semantic self improvement', 'run semantic refinement', 'repair knowledge gaps', 'closed learning loop', 'knowledge gap repair'], parameters: ['knowledgeSpaceId', 'sourceIds', 'gapIds', 'limit', 'maxRunMs', 'force', 'confirm', 'explicitUserRequest'] },
  { id: 'autonomy_intake', kind: 'discover', family: 'personal-ops', summary: 'Route ongoing work with schedule and watcher trigger posture.', next: 'Prefer autonomy action:"intake"; use returned route or action:"queue".', keywords: ['incoming webhook', 'webhook watcher', 'watcher trigger', 'event trigger', 'gmail trigger', 'cron wakeup'], parameters: ['query', 'target', 'includeParameters'] },
  { id: 'autonomy_queue', kind: 'discover', family: 'personal-ops', summary: 'List autonomy work with live records, tails, and controls.', next: 'Prefer autonomy action:"queue"; inspect one with action:"item".', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'autonomy_queue_item', kind: 'inspect', family: 'personal-ops', summary: 'Inspect one autonomy card, live records, tails, and routes.', next: 'Prefer autonomy action:"item".', parameters: ['queueItemId', 'target', 'query'] },
  { id: 'learning_curator', kind: 'discover', family: 'personal-ops', summary: 'Rank memory, notes, personas, skills, routines review/proposals.', next: 'Prefer memory action:"curator"; use action:"candidate" for one card.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'learning_candidate', kind: 'inspect', family: 'personal-ops', summary: 'Inspect one local-learning candidate and safe existing routes.', parameters: ['candidateId', 'target', 'query'] },
  { id: 'learning_auto_promote', kind: 'effect', family: 'personal-ops', summary: 'Promote ready-to-promote; consolidate duplicates on confirmation.', next: 'Use memory action:"curator" to see eligible items, then confirm.', requiresConfirmation: true, keywords: ['auto promote', 'promotion', 'consolidate duplicates', 'learning loop', 'auto learning'], parameters: ['confirm', 'explicitUserRequest'] },
  { id: 'research_briefing', kind: 'discover', family: 'research', summary: 'Show one next-action queue for research runs, sources, reports.', next: 'Use research action:"briefing".', keywords: ['deep research', 'research cockpit', 'research next actions', 'research queue', 'source review', 'report queue'], parameters: ['query', 'target', 'limit', 'includeParameters'] },
  { id: 'research_workflow', kind: 'discover', family: 'research', summary: 'Plan research routes across run, source, report, browser, Knowledge.', next: 'Use research action:"plan"; runner checks browser readiness only.', parameters: ['query', 'target', 'runId', 'includeParameters'] },
  { id: 'research_runs', kind: 'discover', family: 'research', summary: 'List deep-research runs, phase, log tails, and controls.', next: 'Use research_run for one run.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'research_run', kind: 'inspect', family: 'research', summary: 'Inspect one research run, log tail, checkpoints, and controls.', parameters: ['runId', 'target', 'query'] },
  { id: 'research_queue', kind: 'discover', family: 'research', summary: 'List research sources, credibility, bundle route, and next actions.', next: 'Use research_source for one source.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'research_source', kind: 'inspect', family: 'research', summary: 'Inspect one source, report line, bundle, review, or ingest routes.', parameters: ['sourceId', 'target', 'query'] },
  { id: 'document_ops', kind: 'discover', family: 'documents', summary: 'Map document uploads, artifacts, packet wizard, blind model compare.', next: 'Use document_ops_lane for wizard, readiness, artifacts, compare.', keywords: ['document upload', 'document uploads', 'artifact', 'artifacts', 'blind model comparison', 'blind model compare'], parameters: ['includeParameters'] },
  { id: 'document_ops_lane', kind: 'inspect', family: 'documents', summary: 'Inspect document packet wizard, artifacts, readiness, blind compare.', keywords: ['document upload', 'document uploads', 'artifact', 'artifacts', 'blind model comparison', 'blind model compare'], parameters: ['laneId', 'target', 'query'] },
  { id: 'pairing_posture', kind: 'discover', family: 'companion', summary: 'List pairing, tokens, and device capability readiness.', next: 'Use pairing_route.', keywords: ['mobile', 'phone', 'device', 'camera', 'screen', 'location', 'voice', 'pwa', 'companion capability', 'device commands'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'pairing_route', kind: 'inspect', family: 'companion', summary: 'Inspect one pairing or device capability handoff.', keywords: ['mobile', 'phone', 'device', 'camera', 'screen', 'location', 'voice', 'pwa', 'companion capability', 'device commands'], parameters: ['pairingRouteId', 'target', 'query'] },
  { id: 'delegation_posture', kind: 'discover', family: 'delegation', summary: 'List explicit build/fix/review delegation routes and boundaries.', next: 'Prefer delegation action:"status|routes"; use action:"route" for one.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'delegation_route', kind: 'inspect', family: 'delegation', summary: 'Inspect one delegation route and exact visible submission contract.', next: 'Prefer delegation action:"route".', parameters: ['delegationRouteId', 'target', 'query'] },
  { id: 'security_posture', kind: 'discover', family: 'security', summary: 'List security posture findings without exposing secrets or raw config.', next: 'Use security_finding.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'security_finding', kind: 'inspect', family: 'security', summary: 'Inspect one security posture finding and safe remediation route.', parameters: ['findingId', 'target', 'query'] },
  { id: 'policy_explain', kind: 'inspect', family: 'security', summary: 'Explain one model action policy and confirmation route.', next: 'Prefer security action:"explain".', keywords: ['why allowed', 'why denied', 'requires confirmation', 'permission policy', 'tool policy'], parameters: ['toolName', 'tool', 'toolArgs', 'target', 'query', 'includeParameters'] },
  { id: 'support_bundles', kind: 'discover', family: 'support', summary: 'List support bundle artifacts and redacted export/import posture.', next: 'Use support_bundle.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'support_bundle', kind: 'inspect', family: 'support', summary: 'Inspect one support bundle artifact and redaction posture.', parameters: ['bundlePath', 'target', 'query'] },
  { id: 'media_posture', kind: 'discover', family: 'media', summary: 'List media/voice readiness, browser posture, and artifact routes.', next: 'Use media_provider or agent_media_generate.', keywords: ['push to talk', 'wake word', 'spoken response', 'tts voice', 'voice controls', 'phone voice'], parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'media_provider', kind: 'inspect', family: 'media', summary: 'Inspect one voice or media provider readiness entry.', keywords: ['push to talk', 'wake word', 'spoken response', 'tts voice', 'voice controls', 'phone voice'], parameters: ['mediaProviderId', 'target', 'query'] },
  { id: 'sessions', kind: 'discover', family: 'sessions', summary: 'List saved sessions, bookmarks, exports, and pending approvals posture.', next: 'Use session.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'session', kind: 'inspect', family: 'sessions', summary: 'Inspect one saved session or bookmark entry.', parameters: ['sessionId', 'target', 'query'] },
  // The keywords are the domains a person asks for by name rather than by key
  // prefix. A model searching modes for "payment" used to find nothing and
  // report that the platform has no payments, while payments.* held 32 live
  // keys. The settings mode is where those are, so it says so.
  { id: 'settings', kind: 'discover', family: 'settings', summary: 'Search Agent settings compactly by category, prefix, or query.', next: 'Prefer settings action:"list|get|set|reset|import".', keywords: ['payment', 'payments', 'credit card', 'spending limit', 'budget', 'purchase', 'billing address', 'shipping address', 'birthday', 'occasion', 'wake word', 'theme', 'model', 'api key', 'permission', 'telegram'], parameters: ['category', 'prefix', 'query', 'includeHidden', 'limit', 'includeParameters'] },
  { id: 'get_setting', kind: 'inspect', family: 'settings', summary: 'Inspect one Agent setting descriptor, value, default, and policy.', keywords: ['payment', 'payments', 'credit card', 'spending limit', 'budget'], parameters: ['key', 'target', 'query'] },
  { id: 'set_setting', kind: 'effect', family: 'settings', summary: 'Set one Agent-owned setting through config/secret managers.', requiresConfirmation: true, parameters: ['key', 'target', 'query', 'value', 'confirm', 'explicitUserRequest'] },
  { id: 'reset_setting', kind: 'effect', family: 'settings', summary: 'Reset one Agent-owned setting and delete secret refs when needed.', requiresConfirmation: true, parameters: ['key', 'target', 'query', 'confirm', 'explicitUserRequest'] },
  { id: 'workspace', kind: 'discover', family: 'workspace', summary: 'List Agent workspace categories and action counts.', next: 'Prefer workspace action:"status|actions|action".' },
  { id: 'workspace_categories', kind: 'discover', family: 'workspace', summary: 'Alias of workspace for category discovery.', next: 'Prefer workspace action:"status|actions|action".', aliases: ['workspace'] },
  { id: 'workspace_actions', kind: 'discover', family: 'workspace', summary: 'Search all user-facing Agent workspace actions and compact model routes.', next: 'Prefer workspace action:"actions|action|run".', parameters: ['categoryId', 'query', 'limit', 'includeParameters'] },
  { id: 'workspace_action', kind: 'inspect', family: 'workspace', summary: 'Inspect one workspace action, editor schema, route, and safety policy.', parameters: ['actionId', 'command', 'target', 'query', 'recordId'] },
  { id: 'run_workspace_action', kind: 'effect', family: 'workspace', summary: 'Run a workspace action or return its model execution handoff.', requiresConfirmation: true, parameters: ['actionId', 'command', 'target', 'query', 'recordId', 'fields', 'confirm', 'explicitUserRequest'] },
  { id: 'tools', kind: 'discover', family: 'tools', summary: 'List first-class model tool definitions compactly.', next: 'Use tool for full schema.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'tool', kind: 'inspect', family: 'tools', summary: 'Inspect one first-class model tool definition and JSON schema.', parameters: ['toolName', 'target', 'query'] },
  { id: 'release_evidence', kind: 'discover', family: 'operator-audit', summary: 'List packaged operator/audit release artifacts compactly.', next: 'Use release_evidence_artifact.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'release_evidence_artifact', kind: 'inspect', family: 'operator-audit', summary: 'Inspect one operator/audit release artifact and optional content.', parameters: ['artifactId', 'target', 'query'] },
  { id: 'release_readiness', kind: 'discover', family: 'operator-audit', summary: 'Search the operator/audit release-quality inventory.', next: 'Use release_readiness_item.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'release_readiness_item', kind: 'inspect', family: 'operator-audit', summary: 'Inspect one operator/audit readiness inventory item.', parameters: ['itemId', 'target', 'query'] },
  { id: 'operator_methods', kind: 'discover', family: 'operator', summary: 'List GoodVibes daemon operator methods from the live SDK contract.', next: 'Prefer host action:"methods|method"; execute with agent_operator_method.', parameters: ['query', 'limit', 'includeParameters'] },
  { id: 'operator_method', kind: 'inspect', family: 'operator', summary: 'Inspect one daemon method, route, effect, and confirmation policy.', next: 'Prefer host action:"method".', parameters: ['methodId', 'target', 'query'] },
  { id: 'service_posture', kind: 'discover', family: 'connected-host', summary: 'Inspect service endpoint posture, binding, issues, and probes.', next: 'Prefer host action:"services|service".', parameters: ['includeParameters'] },
  { id: 'service_endpoint', kind: 'inspect', family: 'connected-host', summary: 'Inspect one service endpoint binding and lifecycle boundary.', parameters: ['endpointId', 'target', 'query'] },
  { id: 'connected_host', kind: 'discover', family: 'connected-host', summary: 'Map connected-host capabilities, boundaries, and tool availability.', next: 'Prefer host action:"capabilities|capability|status".', parameters: ['includeParameters'] },
  { id: 'connected_host_status', kind: 'inspect', family: 'connected-host', summary: 'Run live read-only connected-host readiness checks.', next: 'Prefer host action:"status".', parameters: ['includeParameters'] },
  { id: 'connected_host_capability', kind: 'inspect', family: 'connected-host', summary: 'Inspect one connected-host capability and blocked surfaces.', next: 'Prefer host action:"capability".', parameters: ['capabilityId', 'target', 'query'] },
  { id: 'daemon', kind: 'alias', family: 'connected-host', summary: 'GoodVibes daemon -> connected_host; mutations use confirmed methods.', next: 'Prefer host action:"capabilities".', aliases: ['connected_host'], parameters: ['includeParameters'] },
  { id: 'daemon_status', kind: 'alias', family: 'connected-host', summary: 'GoodVibes daemon status -> connected_host_status.', next: 'Prefer host action:"status".', aliases: ['connected_host_status'], parameters: ['includeParameters'] },
  { id: 'propose_skill_drafts', kind: 'effect', family: 'personal-ops', summary: 'Draft up to 3 skills from recent learning candidates for review.', requiresConfirmation: true, keywords: ['skill draft', 'propose skill', 'auto-propose', 'draft skills', 'learning draft'], parameters: ['confirm', 'explicitUserRequest'] },
  { id: 'remote_snapshot', kind: 'inspect', family: 'remote', summary: 'Route for the remote execution snapshot.', next: 'Call agent_operator_method methodId:"remote.snapshot".', keywords: ['remote execution', 'remote peers', 'remote work', 'distributed execution', 'remote runner', 'pair requests', 'remote snapshot'], parameters: ['includeParameters'] },
  { id: 'remote_peers', kind: 'inspect', family: 'remote', summary: 'Route to list connected remote peers.', next: 'Call agent_operator_method methodId:"remote.peers.list".', keywords: ['remote peers', 'connected peers', 'distributed execution', 'remote runner', 'peer list'], parameters: ['includeParameters'] },
  { id: 'remote_work', kind: 'inspect', family: 'remote', summary: 'Route to list queued and leased remote work.', next: 'Call agent_operator_method methodId:"remote.work.list".', keywords: ['remote work', 'queued work', 'leased work', 'distributed execution', 'remote work items', 'work queue'], parameters: ['includeParameters'] },
  { id: 'remote_pair_requests', kind: 'inspect', family: 'remote', summary: 'Route to list remote pair requests.', next: 'Call agent_operator_method methodId:"remote.pair.requests.list".', keywords: ['remote pairing', 'pair requests', 'pending pair', 'distributed execution', 'remote pair'], parameters: ['includeParameters'] },
  { id: 'remote_pair_approve', kind: 'effect', family: 'remote', summary: 'Confirmed handoff to approve a remote pair request.', requiresConfirmation: true, next: 'Execute the returned modelRoute with agent_operator_method.', keywords: ['approve pair request', 'remote pairing', 'accept pair', 'distributed execution'], parameters: ['requestId', 'target', 'note', 'confirm', 'explicitUserRequest'] },
  { id: 'remote_pair_reject', kind: 'effect', family: 'remote', summary: 'Confirmed handoff to reject a remote pair request.', requiresConfirmation: true, next: 'Execute the returned modelRoute with agent_operator_method.', keywords: ['reject pair request', 'remote pairing', 'deny pair', 'distributed execution'], parameters: ['requestId', 'target', 'note', 'confirm', 'explicitUserRequest'] },
  { id: 'remote_peers_invoke', kind: 'effect', family: 'remote', summary: 'Confirmed handoff to invoke a command on a peer.', requiresConfirmation: true, next: 'Execute the returned modelRoute with agent_operator_method.', keywords: ['peer invoke', 'remote command', 'invoke peer', 'distributed execution', 'remote execution'], parameters: ['peerId', 'command', 'payload', 'target', 'confirm', 'explicitUserRequest'] },
  { id: 'remote_work_cancel', kind: 'effect', family: 'remote', summary: 'Confirmed handoff to cancel a remote work item.', requiresConfirmation: true, next: 'Execute the returned modelRoute with agent_operator_method.', keywords: ['cancel work', 'remote work cancel', 'cancel remote work', 'distributed execution'], parameters: ['workId', 'target', 'reason', 'confirm', 'explicitUserRequest'] },
  { id: 'unified_inbox', kind: 'inspect', family: 'comms', summary: 'Aggregated unified inbox: deliveries, messages, routes.', next: 'Call channel_triage first; inbox aggregates triage.', keywords: ['inbox', 'unified inbox', 'deliveries', 'surface messages', 'route bindings', 'channel inbox', 'message feed'], parameters: ['limit'] },
  { id: 'channel_drafts', kind: 'discover', family: 'comms', summary: 'List or inspect channel message drafts.', next: 'Use draftId to inspect one draft.', keywords: ['draft', 'channel draft', 'message draft', 'saved draft', 'pending message'], parameters: ['draftId', 'draftStatus', 'target', 'query', 'limit'] },
  { id: 'channel_draft_save', kind: 'effect', family: 'comms', summary: 'Save or update a channel message draft.', requiresConfirmation: true, next: 'After save, use channel_draft_send to deliver.', keywords: ['save draft', 'create draft', 'update draft', 'draft message', 'compose'], parameters: ['draftId', 'draftMessage', 'draftTitle', 'draftChannel', 'draftRoute', 'draftWebhook', 'draftLink', 'draftTags', 'confirm', 'explicitUserRequest'] },
  { id: 'channel_draft_send', kind: 'effect', family: 'comms', summary: 'Queue a draft and send via confirmed delivery path.', requiresConfirmation: true, next: 'Sends via agent_channel_send delivery path.', keywords: ['send draft', 'deliver draft', 'queue draft', 'draft send', 'channel send draft'], parameters: ['draftId', 'target', 'confirm', 'explicitUserRequest'] },
  { id: 'channel_routing', kind: 'discover', family: 'comms', summary: 'List or inspect channel-to-profile routing rules.', next: 'Use surfaceKind/routeId to inspect one route.', keywords: ['channel routing', 'profile routing', 'routing rules', 'channel profile', 'surface routing'], parameters: ['surfaceKind', 'draftRoute', 'target', 'query', 'limit'] },
  { id: 'channel_routing_assign', kind: 'effect', family: 'comms', summary: 'Assign a channel surface to a profile route.', requiresConfirmation: true, next: 'Check channel_routing to see saved assignments.', keywords: ['assign channel', 'profile assign', 'routing assign', 'channel to profile', 'route assign'], parameters: ['surfaceKind', 'profileId', 'draftRoute', 'routeLabel', 'confirm', 'explicitUserRequest'] },
  { id: 'channel_routing_remove', kind: 'effect', family: 'comms', summary: 'Remove a channel-to-profile routing assignment.', requiresConfirmation: true, next: 'Check channel_routing after removal.', keywords: ['remove routing', 'delete routing', 'routing remove', 'profile unassign', 'unassign channel'], parameters: ['draftRoute', 'target', 'confirm', 'explicitUserRequest'] },
] as const;

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function describeHarnessModeDescriptor(
  descriptor: HarnessModeDescriptor,
  options: { readonly includeParameters?: boolean; readonly lookup?: Record<string, unknown> } = {},
): Record<string, unknown> {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    family: descriptor.family,
    summary: descriptor.summary,
    modelRoute: `agent_harness mode:"${descriptor.id}"`,
    ...(descriptor.next ? { next: descriptor.next } : {}),
    ...(descriptor.requiresConfirmation ? { requiresConfirmation: true } : {}),
    ...(descriptor.aliases ? { aliases: descriptor.aliases } : {}),
    ...(options.lookup ? { lookup: options.lookup } : {}),
    ...(options.includeParameters ? {
      parameters: descriptor.parameters ?? [],
      route: `agent_harness mode:"${descriptor.id}"`,
    } : {}),
  };
}

function harnessModeSearchText(descriptor: HarnessModeDescriptor): string {
  return [
    descriptor.id,
    descriptor.id.replace(/_/g, ' '),
    descriptor.kind,
    descriptor.family,
    descriptor.summary,
    descriptor.next,
    ...(descriptor.aliases ?? []),
    ...(descriptor.keywords ?? []),
    ...(descriptor.parameters ?? []),
  ].filter(Boolean).join('\n').toLowerCase();
}

function tokenScore(tokens: readonly string[], value: string | undefined, weight: number): number {
  if (!value) return 0;
  const text = value.toLowerCase();
  return tokens.reduce((score, token) => score + (text.includes(token) ? weight : 0), 0);
}

const ACTION_VERBS = new Set(['run', 'set', 'reset', 'open', 'create', 'send', 'schedule']);

function harnessModeRelevance(descriptor: HarnessModeDescriptor, input: string): number {
  const normalized = input.toLowerCase().trim();
  if (!normalized) return 0;

  const tokens = catalogSearchTokens(normalized);
  const id = descriptor.id.toLowerCase();
  const idPhrase = id.replace(/_/g, ' ');
  const idLookup = normalized.replace(/\s+/g, '_');
  let score = 0;

  if (id === normalized || idPhrase === normalized) score += 10_000;
  if (id.startsWith(idLookup) || idPhrase.startsWith(normalized)) score += 5_000;
  if (id.includes(idLookup) || idPhrase.includes(normalized)) score += 2_500;

  score += tokenScore(tokens, [id, idPhrase, ...(descriptor.aliases ?? [])].join('\n'), 1_000);
  score += tokenScore(tokens, descriptor.family, 500);
  score += tokenScore(tokens, descriptor.kind, 500);
  score += tokenScore(tokens, (descriptor.parameters ?? []).join('\n'), 350);
  score += tokenScore(tokens, descriptor.summary, 200);
  score += tokenScore(tokens, (descriptor.keywords ?? []).join('\n'), 150);
  score += tokenScore(tokens, descriptor.next, 100);

  const actionVerb = tokens.find((token) => ACTION_VERBS.has(token));
  if (actionVerb) {
    const idTokens = catalogSearchTokens(id);
    if (idTokens[0] === actionVerb) score += 2_000;
    if (descriptor.kind === 'effect' && idTokens.includes(actionVerb)) score += 1_000;
  }

  return score;
}

function matchingHarnessModes(input: string): CatalogSearchResult<HarnessModeDescriptor> {
  const found = searchCatalog(HARNESS_MODE_DESCRIPTORS, input, harnessModeSearchText);
  if (!input) return found;
  const ranked = found.matches
    .map((descriptor, index) => ({ descriptor, index, score: harnessModeRelevance(descriptor, input) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map(({ descriptor }) => descriptor);
  return { matches: ranked, relaxed: found.relaxed };
}

function modeLookupInput(args: HarnessModeCatalogArgs): { readonly source: 'target' | 'query'; readonly input: string } | null {
  const target = readString(args.target);
  if (target) return { source: 'target', input: target };
  const query = readString(args.query);
  return query ? { source: 'query', input: query } : null;
}

export function listHarnessModes(args: HarnessModeCatalogArgs): Record<string, unknown> {
  const lookup = modeLookupInput(args);
  const limit = readLimit(args.limit, 120);
  const normalized = lookup?.input.toLowerCase() ?? '';
  const found = matchingHarnessModes(normalized);
  const modes = found.matches
    .map((descriptor) => describeHarnessModeDescriptor(descriptor, { includeParameters: args.includeParameters === true }))
    .slice(0, limit);
  return {
    ...catalogEnvelope('modes', modes, HARNESS_MODE_DESCRIPTORS.length, {
      ...(lookup ? { [lookup.source]: lookup.input } : {}),
    }, 'agent_harness mode:"modes" with no query', { relaxedQuery: found.relaxed }),
    families: Array.from(new Set(HARNESS_MODE_DESCRIPTORS.map((descriptor) => descriptor.family))).sort(),
    policy: 'Mode discovery is read-only. Effect modes still require confirm:true and explicitUserRequest.',
  };
}

export function describeHarnessMode(args: HarnessModeCatalogArgs): HarnessModeResolution {
  const lookup = modeLookupInput(args);
  if (!lookup) {
    return {
      status: 'missing_lookup',
      usage: 'mode inspection requires target or query. Use mode:"modes" to search available harness modes.',
    };
  }
  const normalized = lookup.input.toLowerCase();
  const exact = HARNESS_MODE_DESCRIPTORS.find((descriptor) => descriptor.id === lookup.input);
  if (exact) return { status: 'found', mode: describeHarnessModeDescriptor(exact, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'id' } }) };
  const insensitive = HARNESS_MODE_DESCRIPTORS.find((descriptor) => descriptor.id.toLowerCase() === normalized);
  if (insensitive) return { status: 'found', mode: describeHarnessModeDescriptor(insensitive, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'case-insensitive-id' } }) };
  const searched = matchingHarnessModes(normalized);
  // A relaxed hit matched a WORD of the query, not the query. Naming one of
  // those as THE mode would be a guess with a receipt on it, so loose hits are
  // always offered as candidates for the caller to choose between.
  if (searched.matches.length === 1 && !searched.relaxed) {
    return { status: 'found', mode: describeHarnessModeDescriptor(searched.matches[0]!, { includeParameters: true, lookup: { ...lookup, resolvedBy: 'search' } }) };
  }
  if (searched.matches.length > 0) {
    return {
      status: 'ambiguous',
      input: lookup.input,
      candidates: searched.matches.slice(0, 12).map((descriptor) => describeHarnessModeDescriptor(descriptor)),
    };
  }
  return {
    status: 'missing_lookup',
    usage: `Unknown harness mode ${lookup.input}. Use mode:"modes" to inspect available modes.`,
  };
}
