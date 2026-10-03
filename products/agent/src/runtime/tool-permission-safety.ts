import type { PermissionCategory, PermissionManager } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { HARNESS_MODE_DESCRIPTORS } from '../tools/agent-harness-mode-catalog.ts';
import { normalizeOccasionsAction, OCCASIONS_WRITE_ACTIONS } from '../tools/agent-occasions-types.ts';
import { normalizeProfileAction, PROFILE_WRITE_ACTIONS } from '../tools/agent-profile-types.ts';

type PermissionManagerLike = Pick<PermissionManager, 'check' | 'getCategory'>
  & Partial<Pick<PermissionManager, 'checkDetailed'>>;

function assertPermissionActive(signal: AbortSignal | undefined): void {
  // Never return the caller's abort reason, which can contain private context.
  if (signal?.aborted) throw new DOMException('The permission request was cancelled', 'AbortError');
}

function rethrowCancellation(error: unknown, signal: AbortSignal | undefined): void {
  // The engine's normalized cancellation is a JudgmentError; other permission
  // adapters can use the standard AbortError. Neither is a lookup failure.
  if (error instanceof Error && (error.name === 'AbortError'
    || (error.name === 'JudgmentError' && 'kind' in error && error.kind === 'aborted'))) throw error;
  assertPermissionActive(signal);
}

const SAFETY_MARKER = Symbol.for('goodvibes-agent.permission-safety-installed');

const READ_TOOL_NAMES = new Set([
  'read',
  'find',
  'fetch',
  'analyze',
  'inspect',
  'state',
  'registry',
  'route',
  'repo_map',
  'goodvibes_context',
  'autonomy',
  'channels',
  'computer',
  'context',
  'delegation',
  'device',
  'execution',
  'host',
  'memory',
  'models',
  'personal_ops',
  'research',
  'security',
  'setup',
  'settings',
  'vibe',
  'workspace',
  'agent_knowledge',
  'agent_operator_briefing',
]);

const WRITE_TOOL_NAMES = new Set([
  'write',
  'edit',
  'goodvibes_settings',
  'agent_artifacts',
  'agent_documents',
  'agent_knowledge_ingest',
  'agent_learning_consolidation',
  'agent_local_registry',
  'agent_research_runs',
  'agent_research_sources',
  'agent_research_report',
  'agent_review_packet_presets',
  'agent_work_plan',
]);

const EXECUTE_TOOL_NAMES = new Set(['exec', 'repl', 'terminal', 'process']);
const READ_ONLY_PROCESS_ACTIONS = new Set(['', 'list', 'status', 'poll', 'log', 'output', 'capabilities', 'doctor', 'parity']);
const READ_ONLY_SCHEDULE_ACTIONS = new Set(['', 'list', 'status', 'show']);
const READ_ONLY_SETTINGS_IMPORT_ACTIONS = new Set(['', 'preview', 'inspect', 'show', 'plan']);
const READ_ONLY_SETTINGS_ACTIONS = new Set(['', 'list', 'status', 'settings', 'catalog', 'search', 'find', 'browse', 'get', 'show', 'inspect', 'read', 'setting', 'get_setting', 'import', 'import_settings', 'settings_import', 'import_goodvibes', 'goodvibes_import', 'preview_import']);
const READ_ONLY_SETUP_ACTIONS = new Set(['', 'status', 'summary', 'list', 'item', 'show', 'inspect', 'repair', 'fix', 'diagnose_repair', 'host_repair', 'repair_host', 'launch_host', 'checkpoint', 'checkpoint_status']);
const READ_ONLY_VIBE_ACTIONS = new Set(['', 'status', 'summary', 'list', 'show', 'file', 'source', 'read', 'inspect']);
const READ_ONLY_PERSONAL_OPS_ACTIONS = new Set(['', 'briefing', 'brief', 'daily', 'daily_brief', 'morning', 'status', 'summary', 'overview', 'map', 'list', 'queue', 'queues', 'review_queue', 'review_queues', 'personal_queue', 'ops_queue', 'intake', 'request', 'route', 'plan', 'triage', 'draft', 'lane', 'inspect', 'show']);
const READ_ONLY_RESEARCH_ACTIONS = new Set(['', 'briefing', 'brief', 'status', 'dashboard', 'cockpit', 'next', 'plan', 'workflow', 'research', 'runner', 'browser', 'browser_runner', 'browser_backed', 'deep_research', 'runs', 'list_runs', 'run_list', 'run', 'show_run', 'inspect_run', 'sources', 'queue', 'source_queue', 'source', 'show_source', 'inspect_source', 'bundle', 'bundle_sources', 'source_bundle', 'search', 'public_search', 'collect', 'collect_sources', 'source_candidates', 'reports', 'list_reports', 'report_list', 'visual_reports', 'report_artifact', 'show_report', 'inspect_report', 'show_visual_report', 'visual_report_artifact']);
const READ_ONLY_CHANNELS_ACTIONS = new Set(['', 'status', 'summary', 'list', 'readiness', 'channels', 'channel', 'show', 'inspect', 'setup', 'guide', 'setup_guide', 'channel_setup_guide', 'triage', 'inbox', 'blockers', 'retries', 'channel_triage', 'deliveries', 'delivery', 'receipts', 'history', 'channel_deliveries']);
const READ_ONLY_MEMORY_ACTIONS = new Set(['', 'status', 'summary', 'posture', 'memory_posture', 'recall', 'providers', 'provider', 'memory_provider', 'embedding', 'external', 'external_provider', 'refinement', 'refinement_tasks', 'semantic_refinement', 'self_improvement', 'semantic_self_improvement', 'learning_loop', 'curator', 'learning', 'learning_curator', 'queue', 'review_queue', 'plan', 'candidate', 'learning_candidate', 'card', 'inspect_candidate', 'list', 'records', 'memories', 'search', 'find', 'lookup', 'get', 'show', 'inspect', 'read']);
// Browser actions that only observe. Everything else, navigating, clicking,
// typing, launching, screenshots, is an external effect and is categorized as
// a write so it goes through the same approval path as any other real action.
const READ_ONLY_BROWSER_ACTIONS = new Set(['', 'status', 'tabs', 'snapshot', 'read_text']);
const READ_ONLY_COMPUTER_ACTIONS = new Set(['', 'status', 'summary', 'overview', 'computer', 'computer_use', 'plan', 'route', 'control_plan', 'browser_plan', 'desktop_plan', 'control', 'browser_control', 'desktop', 'desktop_control', 'screenshot', 'screen', 'screen_recording', 'observe', 'browser', 'pwa', 'cockpit', 'browser_cockpit', 'web', 'setup', 'configure', 'browser_desktop_control', 'mcp', 'tools', 'servers', 'mcp_servers']);
const READ_ONLY_DEVICE_ACTIONS = new Set(['', 'status', 'map', 'capabilities', 'device', 'devices', 'mobile', 'phone', 'pairing', 'capability', 'route', 'pairing_route', 'show', 'inspect', 'browser', 'pwa', 'cockpit', 'browser_cockpit', 'web', 'control', 'browser_control', 'desktop', 'desktop_control', 'computer_use', 'voice', 'media', 'voice_media', 'workflows', 'provider', 'media_provider', 'voice_provider']);
const READ_ONLY_MODELS_ACTIONS = new Set(['', 'status', 'routing', 'routes', 'models', 'model', 'readiness', 'route_readiness', 'route', 'model_route', 'inspect', 'show', 'candidate', 'endpoint', 'local', 'cookbook', 'local_cookbook', 'recipes', 'recipe', 'ollama', 'llama_cpp', 'llamacpp', 'vllm', 'local_servers', 'providers', 'provider_accounts', 'accounts', 'subscriptions', 'auth', 'logins', 'provider', 'provider_account', 'account', 'subscription', 'auth_status']);
const READ_ONLY_WORKSPACE_ACTIONS = new Set(['', 'status', 'summary', 'home', 'workspace', 'categories', 'workspace_categories', 'actions', 'list_actions', 'workspace_actions', 'tasks', 'action', 'show', 'inspect', 'workspace_action', 'surfaces', 'ui_surfaces', 'screens', 'views', 'surface', 'ui_surface', 'screen', 'view', 'shortcuts', 'shortcut_help', 'help', 'keybindings', 'bindings', 'keys', 'keybinding', 'binding', 'key', 'commands', 'slash_commands', 'command_catalog', 'command', 'slash_command', 'inspect_command', 'cli_commands', 'cli_catalog', 'cli_command', 'inspect_cli_command']);
const READ_ONLY_AUTONOMY_ACTIONS = new Set(['', 'intake', 'request', 'route', 'plan', 'triage', 'autonomy_intake', 'queue', 'list', 'work', 'ongoing', 'autonomy_queue', 'item', 'card', 'show', 'inspect', 'autonomy_queue_item', 'status', 'summary', 'overview']);
const READ_ONLY_DELEGATION_ACTIONS = new Set(['', 'status', 'summary', 'overview', 'policy', 'decision', 'decisions', 'delegation_posture', 'routes', 'list', 'catalog', 'posture', 'route', 'item', 'card', 'show', 'inspect', 'delegation_route']);
const READ_ONLY_EXECUTION_ACTIONS = new Set(['', 'status', 'summary', 'overview', 'routes', 'posture', 'execution_posture', 'route', 'show_route', 'inspect_route', 'execution_route', 'history', 'activity', 'records', 'execution_history', 'record', 'item', 'show', 'inspect', 'execution_history_item', 'processes', 'background', 'backgrounds', 'background_processes', 'capabilities', 'process_capabilities', 'process', 'background_process', 'recovery', 'file_recovery', 'undo_redo']);

// The agent_harness tool takes a `mode`. Every mode whose catalog kind is not
// 'effect' only inspects, lists, or aliases read-only state, so it classifies as
// 'read'. Every 'effect' mode changes settings, memory, skills, personas,
// routines, keybindings, drafts, or runs a promotion/consolidation/command pass,
// so it classifies as a write. A mode string that is absent from the catalog
// (unknown or misspelled) is deliberately treated as a write, never a read.
const READ_ONLY_HARNESS_MODES: ReadonlySet<string> = new Set(
  HARNESS_MODE_DESCRIPTORS
    .filter((descriptor) => descriptor.kind !== 'effect')
    .map((descriptor) => descriptor.id),
);

type MarkedPermissionManager = PermissionManagerLike & { [SAFETY_MARKER]?: true };

export function installPermissionManagerSafetyGuard(manager: PermissionManagerLike): void {
  const marked = manager as MarkedPermissionManager;
  if (marked[SAFETY_MARKER]) return;
  marked[SAFETY_MARKER] = true;

  const originalGetCategory = manager.getCategory.bind(manager);
  const originalCheck = manager.check.bind(manager);
  const originalCheckDetailed = manager.checkDetailed?.bind(manager);

  manager.getCategory = (toolName, args = {}) => {
    try {
      const category = originalGetCategory(toolName, args);
      const knownCategory = fallbackPermissionCategoryForArgs(toolName, args);
      return category === 'delegate' && knownCategory !== 'delegate' ? knownCategory : category;
    } catch {
      return fallbackPermissionCategoryForArgs(toolName, args);
    }
  };

  manager.check = async (...input: Parameters<PermissionManager['check']>) => {
    const [toolName, args, , options] = input;
    const signal = options?.signal;
    assertPermissionActive(signal);
    try {
      const approved = await originalCheck(...input);
      assertPermissionActive(signal);
      return approved;
    } catch (error) {
      rethrowCancellation(error, signal);
      return fallbackPermissionCategoryForArgs(toolName, args) === 'read';
    }
  };

  if (originalCheckDetailed) {
    manager.checkDetailed = async (...input: Parameters<PermissionManager['checkDetailed']>) => {
      const [toolName, args, , options] = input;
      const signal = options?.signal;
      assertPermissionActive(signal);
      try {
        const result = await originalCheckDetailed(...input);
        assertPermissionActive(signal);
        return result;
      } catch (error) {
        rethrowCancellation(error, signal);
        const category = fallbackPermissionCategoryForArgs(toolName, args);
        const approved = category === 'read';
        return {
          approved,
          persisted: false,
          sourceLayer: 'runtime_mode',
          reasonCode: approved ? 'config_allow' : 'config_deny',
          analysis: {
            classification: 'generic',
            riskLevel: category === 'read' ? 'low' : 'high',
            summary: `Permission fallback for ${toolName}: ${summarizeError(error)}`,
            reasons: ['permission-manager-exception'],
          },
        };
      }
    };
  }
}

export function fallbackPermissionCategory(toolName: string): PermissionCategory {
  if (READ_TOOL_NAMES.has(toolName)) return 'read';
  if (WRITE_TOOL_NAMES.has(toolName)) return 'write';
  if (EXECUTE_TOOL_NAMES.has(toolName)) return 'execute';
  return 'delegate';
}

export function fallbackPermissionCategoryForArgs(toolName: string, args: Record<string, unknown>): PermissionCategory {
  if (toolName === 'process') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase()
      : typeof args.processAction === 'string'
        ? args.processAction.trim().toLowerCase()
        : '';
    return READ_ONLY_PROCESS_ACTIONS.has(action) ? 'read' : 'execute';
  }
  if (toolName === 'schedule') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase()
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase()
        : '';
    return READ_ONLY_SCHEDULE_ACTIONS.has(action) ? 'read' : 'execute';
  }
  if (toolName === 'import_goodvibes_settings') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase()
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase()
        : '';
    return READ_ONLY_SETTINGS_IMPORT_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'settings') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    const confirmed = args.confirm === true || (typeof args.confirm === 'string' && ['true', 'yes', 'apply', 'run'].includes(args.confirm.trim().toLowerCase()));
    if ((action === 'import' || action === 'import_settings' || action === 'settings_import' || action === 'import_goodvibes' || action === 'goodvibes_import') && confirmed) return 'write';
    return READ_ONLY_SETTINGS_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'setup') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_SETUP_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'vibe') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_VIBE_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'personal_ops') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_PERSONAL_OPS_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'research') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_RESEARCH_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'channels') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_CHANNELS_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'memory') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_MEMORY_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'browser') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : '';
    return READ_ONLY_BROWSER_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'computer') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_COMPUTER_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'device') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_DEVICE_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'models') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_MODELS_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'workspace') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_WORKSPACE_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'autonomy') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_AUTONOMY_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'delegation') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_DELEGATION_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'execution') {
    const action = typeof args.action === 'string'
      ? args.action.trim().toLowerCase().replace(/-/g, '_')
      : typeof args.mode === 'string'
        ? args.mode.trim().toLowerCase().replace(/-/g, '_')
        : '';
    return READ_ONLY_EXECUTION_ACTIONS.has(action) ? 'read' : 'write';
  }
  if (toolName === 'profile') {
    // The owner-profile actions split cleanly: four look things up, four change
    // the file. Classified honestly rather than conveniently, an autonomous
    // write is still a write, and the owner declined a confirmation prompt on
    // the profile FEATURE, not on the permission layer's posture for the tool.
    // Both sides read the SAME action vocabulary, so an alias can never
    // classify as a read here and act as a write there. An action the tool does
    // not recognise is a write, never auto-approved as a read.
    const action = normalizeProfileAction(args.action) ?? normalizeProfileAction(args.mode);
    return action === null || PROFILE_WRITE_ACTIONS.has(action) ? 'write' : 'read';
  }
  if (toolName === 'occasions') {
    // Same treatment, and for the same reason, as `profile` above: the actions
    // split cleanly between the five that only look and the eight that change
    // durable state, the acknowledgement store for an answer or an interview, and
    // the owner's own profile file for a capture or a removal. Both sides read the
    // SAME action vocabulary (tools/agent-occasions-types.ts), so an alias can
    // never classify as a read here and act as a write there. An action the tool
    // does not recognise is a write, never auto-approved as a read.
    const action = normalizeOccasionsAction(args.action) ?? normalizeOccasionsAction(args.mode);
    return action === null || OCCASIONS_WRITE_ACTIONS.has(action) ? 'write' : 'read';
  }
  if (toolName === 'agent_harness') {
    const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
    return READ_ONLY_HARNESS_MODES.has(mode) ? 'read' : 'write';
  }
  if (toolName === 'agent_artifacts') {
    const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
    return mode === 'list' || mode === 'show' ? 'read' : 'write';
  }
  if (toolName === 'agent_review_packet_presets') {
    const mode = typeof args.mode === 'string' ? args.mode.trim() : '';
    return mode === 'list' || mode === 'show' || mode === '' ? 'read' : 'write';
  }
  return fallbackPermissionCategory(toolName);
}
