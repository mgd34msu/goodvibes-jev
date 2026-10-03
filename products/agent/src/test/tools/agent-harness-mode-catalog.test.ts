import { describe, expect, test } from 'bun:test';
import { AGENT_HARNESS_MODES } from '../../tools/agent-harness-tool-schema.ts';
import {
  describeHarnessMode,
  HARNESS_MODE_DESCRIPTORS,
  listHarnessModes,
} from '../../tools/agent-harness-mode-catalog.ts';

describe('agent_harness mode catalog', () => {
  test('stays in sync with the public tool schema and keeps effect modes confirmation-gated', () => {
    const schemaModes = [...AGENT_HARNESS_MODES].sort();
    const catalogModes = HARNESS_MODE_DESCRIPTORS.map((descriptor) => descriptor.id).sort();

    expect(new Set(catalogModes).size).toBe(catalogModes.length);
    expect(catalogModes).toEqual(schemaModes);

    // Every effect mode must be confirmation-gated: it declares
    // requiresConfirmation and exposes the confirm + explicitUserRequest
    // parameters. There are no carve-outs, the learning promotion pass is gated
    // like the rest because it creates and deletes memory, personas, and routines.
    const unsafeEffects = HARNESS_MODE_DESCRIPTORS
      .filter((descriptor) => descriptor.kind === 'effect')
      .filter((descriptor) => (
        descriptor.requiresConfirmation !== true
        || !descriptor.parameters?.includes('confirm')
        || !descriptor.parameters?.includes('explicitUserRequest')
      ))
      .map((descriptor) => descriptor.id);

    expect(unsafeEffects).toEqual([]);
  });

  test('supports compact discovery by task phrase with opt-in parameter detail', () => {
    const compact = listHarnessModes({ query: 'run slash command' }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly route?: string }[];
    };
    expect(compact.modes[0]?.id).toBe('run_command');
    expect(compact.modes.map((mode) => mode.id)).toContain('run_command');
    expect(compact.modes.filter((mode) => mode.parameters !== undefined || mode.route !== undefined)).toEqual([]);

    const detailed = listHarnessModes({ query: 'args explicitUserRequest', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly route?: string }[];
    };
    const runCommand = detailed.modes.find((mode) => mode.id === 'run_command');
    expect(runCommand).toMatchObject({
      id: 'run_command',
      route: 'agent_harness mode:"run_command"',
    });
    expect(runCommand?.parameters).toEqual(expect.arrayContaining(['confirm', 'explicitUserRequest']));
  });

  test('finds route decision by user-task wording', () => {
    const routes = listHarnessModes({ query: 'which tool should this user task use one assistant route', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const routeDecision = routes.modes.find((mode) => mode.id === 'route_decision');
    expect(routeDecision?.parameters).toEqual(expect.arrayContaining(['query', 'target', 'limit', 'includeParameters']));
    expect(routes.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds connected-host daemon aliases by GoodVibes daemon wording', () => {
    const daemon = listHarnessModes({ query: 'goodvibes-daemon', limit: 5 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = daemon.modes.map((mode) => mode.id);
    expect(ids).toContain('daemon');
    expect(ids).toContain('daemon_status');
    expect(daemon.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds background process controls by process, PTY, and sudo wording', () => {
    const processModes = listHarnessModes({ query: 'background process', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = processModes.modes.map((mode) => mode.id);
    expect(ids).toContain('background_processes');
    expect(ids).toContain('background_process');
    expect(ids).toContain('run_background_process');
    expect(processModes.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const pty = listHarnessModes({ query: 'pty', limit: 10 }) as {
      readonly modes: readonly { readonly id: string }[];
    };
    expect(pty.modes.map((mode) => mode.id)).toContain('run_background_process');
    const sudo = listHarnessModes({ query: 'sudo', limit: 10 }) as {
      readonly modes: readonly { readonly id: string }[];
    };
    expect(sudo.modes.map((mode) => mode.id)).toContain('run_background_process');
    expect(sudo.modes.map((mode) => mode.id)).toContain('setup_posture');
    expect(sudo.modes.map((mode) => mode.id)).toContain('execution_posture');

    const processTool = listHarnessModes({ query: 'process tool session id poll kill write', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[] }[];
    };
    const runBackgroundProcess = processTool.modes.find((mode) => mode.id === 'run_background_process');
    expect(runBackgroundProcess?.parameters).toEqual(expect.arrayContaining([
      'processAction',
      'action',
      'sessionId',
      'session_id',
      'processSessionId',
      'data',
    ]));

    const browserPlan = listHarnessModes({ query: 'take screenshot browser desktop control plan', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const browserPlanMode = browserPlan.modes.find((mode) => mode.id === 'browser_control_route');
    expect(browserPlanMode?.parameters).toEqual(expect.arrayContaining(['query', 'target', 'includeParameters']));
    expect(browserPlan.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds Personal Ops by natural user task wording', () => {
    const personalOps = listHarnessModes({ query: 'email calendar tasks reminders', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = personalOps.modes.map((mode) => mode.id);
    expect(ids).toContain('personal_ops');
    expect(ids).toContain('personal_ops_intake');
    expect(ids).toContain('personal_ops_lane');
    expect(personalOps.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const dailyBrief = listHarnessModes({ query: 'daily brief morning personal ops', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    expect(dailyBrief.modes.map((mode) => mode.id)).toContain('personal_ops_briefing');
    expect(dailyBrief.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const trigger = listHarnessModes({ query: 'incoming webhook watcher trigger', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    expect(trigger.modes.map((mode) => mode.id)).toContain('autonomy_intake');
    expect(trigger.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds Research briefing by next-action wording', () => {
    const research = listHarnessModes({ query: 'deep research next actions source review report queue', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = research.modes.map((mode) => mode.id);
    expect(ids).toContain('research_briefing');
    const queue = listHarnessModes({ query: 'research sources credibility bundle route', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    expect(queue.modes.map((mode) => mode.id)).toContain('research_queue');
    expect(research.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
    expect(queue.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds memory posture by recall and external memory provider wording', () => {
    const memory = listHarnessModes({ query: 'memory recall Honcho Mem0 Supermemory', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = memory.modes.map((mode) => mode.id);
    expect(ids).toContain('memory_posture');
    expect(ids).toContain('memory_provider');
    expect(memory.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const refinement = listHarnessModes({ query: 'closed learning loop semantic refinement knowledge gaps', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly requiresConfirmation?: boolean; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const refinementIds = refinement.modes.map((mode) => mode.id);
    expect(refinementIds).toContain('memory_refinement');
    expect(refinementIds).toContain('run_memory_refinement');
    expect(refinement.modes.find((mode) => mode.id === 'memory_refinement')?.parameters).toEqual(expect.arrayContaining(['knowledgeSpaceId', 'gapIds', 'includeParameters']));
    expect(refinement.modes.find((mode) => mode.id === 'run_memory_refinement')?.requiresConfirmation).toBe(true);
    expect(refinement.modes.find((mode) => mode.id === 'run_memory_refinement')?.parameters).toEqual(expect.arrayContaining(['gapIds', 'maxRunMs', 'confirm', 'explicitUserRequest']));
    expect(refinement.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds setup posture by first-run always-on wording', () => {
    const setup = listHarnessModes({ query: 'first-run always-on setup', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = setup.modes.map((mode) => mode.id);
    expect(ids).toContain('setup_posture');
    expect(ids).toContain('setup_item');
    expect(setup.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const repair = listHarnessModes({ query: 'repair setup launch host service status receipt', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const repairMode = repair.modes.find((mode) => mode.id === 'setup_repair');
    expect(repairMode?.parameters).toEqual(expect.arrayContaining(['setupItemId', 'query', 'includeParameters']));
    expect(repair.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const smoke = listHarnessModes({ query: 'run setup smoke', includeParameters: true, limit: 5 }) as {
      readonly modes: readonly { readonly id: string; readonly requiresConfirmation?: boolean; readonly parameters?: readonly string[] }[];
    };
    expect(smoke.modes[0]?.id).toBe('run_setup_smoke');
    expect(smoke.modes[0]?.requiresConfirmation).toBe(true);
    expect(smoke.modes[0]?.parameters).toEqual(expect.arrayContaining(['confirm', 'explicitUserRequest']));

    const auth = listHarnessModes({ query: 'connected host token provision', includeParameters: true, limit: 5 }) as {
      readonly modes: readonly { readonly id: string; readonly requiresConfirmation?: boolean; readonly parameters?: readonly string[] }[];
    };
    expect(auth.modes[0]?.id).toBe('provision_connected_host_token');
    expect(auth.modes[0]?.requiresConfirmation).toBe(true);
    expect(auth.modes[0]?.parameters).toEqual(expect.arrayContaining(['confirm', 'explicitUserRequest']));
  });

  test('finds confirmed local model smoke by local server wording', () => {
    const smoke = listHarnessModes({ query: 'check local servers ollama models', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly requiresConfirmation?: boolean; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const localSmoke = smoke.modes.find((mode) => mode.id === 'run_local_model_smoke');
    expect(localSmoke?.requiresConfirmation).toBe(true);
    expect(localSmoke?.parameters).toEqual(expect.arrayContaining(['modelRouteId', 'timeoutMs', 'confirm', 'explicitUserRequest']));
    expect(smoke.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds project context files by AGENTS, Hermes, Claude, and Cursor wording', () => {
    const context = listHarnessModes({ query: 'AGENTS.md .hermes.md CLAUDE.md cursor rules', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = context.modes.map((mode) => mode.id);
    expect(ids).toContain('project_context');
    expect(ids).toContain('project_context_file');
    expect(context.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds prompt context by selected memory, receipt outcome, and token budget wording', () => {
    const context = listHarnessModes({ query: 'prompt context selected memory token budget receipt outcome filters', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const promptContext = context.modes.find((mode) => mode.id === 'prompt_context');
    expect(promptContext?.parameters).toEqual(expect.arrayContaining(['receiptId', 'turnId', 'outcomeStatus', 'limit', 'includeParameters']));
    expect(context.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds channel delivery receipts by outcome wording', () => {
    const deliveries = listHarnessModes({ query: 'channel delivery receipts sent outcomes', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = deliveries.modes.map((mode) => mode.id);
    expect(ids).toContain('channel_deliveries');
    expect(deliveries.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('finds channel triage by inbox, error, and retry wording', () => {
    const triage = listHarnessModes({ query: 'channel inbox pending messages errors delivery retries', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const ids = triage.modes.map((mode) => mode.id);
    expect(ids).toContain('channel_triage');
    expect(triage.modes.find((mode) => mode.id === 'channel_triage')?.parameters).toEqual(expect.arrayContaining(['limit']));
    expect(triage.modes.filter((mode) => mode.summary.length > 96)).toEqual([]);
  });

  test('finds browser cockpit and PWA surface wording', () => {
    const web = listHarnessModes({ query: 'web dashboard pwa browser cockpit', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly requiresConfirmation?: boolean; readonly summary: string }[];
    };
    const ids = web.modes.map((mode) => mode.id);
    expect(ids).toContain('ui_surfaces');
    expect(ids).toContain('ui_surface');
    expect(ids).toContain('open_ui_surface');
    expect(web.modes.find((mode) => mode.id === 'open_ui_surface')?.requiresConfirmation).toBe(true);
    expect(web.modes.filter((mode) => mode.summary.length > 96)).toEqual([]);
  });

  test('finds companion device capability wording', () => {
    const device = listHarnessModes({ query: 'phone camera location device commands', includeParameters: true, limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[]; readonly summary: string }[];
    };
    const ids = device.modes.map((mode) => mode.id);
    expect(ids).toContain('pairing_posture');
    expect(ids).toContain('pairing_route');
    expect(device.modes.find((mode) => mode.id === 'pairing_posture')?.parameters).toEqual(expect.arrayContaining(['query', 'includeParameters']));
    expect(device.modes.filter((mode) => mode.summary.length > 96)).toEqual([]);

    const voice = listHarnessModes({ query: 'phone voice push to talk', limit: 10 }) as {
      readonly modes: readonly { readonly id: string }[];
    };
    expect(voice.modes.map((mode) => mode.id)).toContain('media_posture');
  });

  test('finds visible Agent orchestration by subagent and batch-spawn wording', () => {
    const orchestration = listHarnessModes({ query: 'subagent batch-spawn multi-agent cancellable agents', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = orchestration.modes.map((mode) => mode.id);
    expect(ids).toContain('agent_orchestration');
    expect(ids).toContain('agent_orchestration_agent');
    expect(orchestration.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);

    const dispatch = listHarnessModes({ query: 'approved work plan dispatch agents', limit: 10 }) as {
      readonly modes: readonly { readonly id: string }[];
    };
    expect(dispatch.modes.map((mode) => mode.id)).toContain('agent_orchestration');
  });

  test('finds Document Ops by uploads, artifacts, and blind compare wording', () => {
    const documentOps = listHarnessModes({ query: 'document upload artifact blind model compare', limit: 10 }) as {
      readonly modes: readonly { readonly id: string; readonly summary: string }[];
    };
    const ids = documentOps.modes.map((mode) => mode.id);
    expect(ids).toContain('document_ops');
    expect(ids).toContain('document_ops_lane');
    expect(documentOps.modes.filter((mode) => mode.summary.length > 72)).toEqual([]);
  });

  test('returns exact, ambiguous, and missing inspection outcomes without guessing', () => {
    expect(describeHarnessMode({ target: 'SET_SETTING' })).toMatchObject({
      status: 'found',
      mode: {
        id: 'set_setting',
        lookup: { resolvedBy: 'case-insensitive-id' },
      },
    });

    const ambiguous = describeHarnessMode({ query: 'setting' });
    expect(ambiguous.status).toBe('ambiguous');
    if (ambiguous.status !== 'ambiguous') throw new Error('expected ambiguous settings lookup');
    expect(ambiguous.candidates.map((candidate) => candidate.id)).toEqual(expect.arrayContaining([
      'settings',
      'get_setting',
      'set_setting',
      'reset_setting',
    ]));

    expect(describeHarnessMode({ query: 'definitely-not-a-mode' })).toMatchObject({
      status: 'missing_lookup',
    });
  });
});
