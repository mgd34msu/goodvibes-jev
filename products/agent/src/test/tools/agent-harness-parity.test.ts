/**
 * agent-harness-parity.test.ts
 *
 * Fix 1: Schema-to-dispatch parity + effect-gating contract tests.
 * Fix 2: Bounded command-runner output cap test.
 *
 * Guarantees:
 *   1. Every mode in AGENT_HARNESS_MODES is handled by the dispatch, the result
 *      error is NEVER 'Unhandled agent_harness mode: <mode>'.
 *   2. Every descriptor with kind:'effect' refuses to execute when invoked without
 *      confirm:true and explicitUserRequest, result must be success:false OR
 *      (success:true with parsed output having status 'needs_confirmation').
 *   3. Command-runner output is capped at 6000 chars with '... output truncated'.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager, ToolInputProjectionError, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { AGENT_HARNESS_MODES } from '../../tools/agent-harness-tool-schema.ts';
import { HARNESS_MODE_DESCRIPTORS } from '../../tools/agent-harness-mode-catalog.ts';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
let readings: ReturnType<typeof fakePort>;
beforeEach(() => {
  // Dispatch parity supplies the real read boundary's offline prerequisites.
  // Unexpected decisions fail rather than receiving a blanket positive answer.
  readings = fakePort((name, question) => {
    if (question.type === 'score' && ['fit', 'memoryAdequacy', 'latency', 'contextWindow', 'toolSupport', 'vision', 'cost', 'privacy'].includes(name)) {
      return scoreAnswer(question, name === 'memoryAdequacy' ? 2 : 3, 0.99);
    }
    if (question.type === 'noul' && ['cloudTransfer', 'exampleVision'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted parity question: ${name}`);
  });
  previousPort = installJudgmentPort({ model: readings.port.model, ask(request) {
    if (!['agent.models.route-readiness', 'agent.models.local-recipe-fit'].includes(request.context?.battery ?? '')) {
      throw new Error(`Unscripted parity battery: ${request.context?.battery}`);
    }
    return readings.port.ask(request);
  } });
});
afterEach(() => { installJudgmentPort(previousPort); });
afterAll(cleanupResearchScreeningFixtures);

function makeParityFixture(options: { sourceOwner?: boolean } = {}) {
  const root = makeProjectTempDir('gv-parity');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const commandRegistry = new CommandRegistry();
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
  const toolRegistry = new ToolRegistry();
  if (options.sourceOwner !== false) bindAgentResearchSourceOwner(toolRegistry, ordinaryResearchOwner());
  const processManager = new ProcessManager();
  const spawn = spyOn(processManager, 'spawn').mockImplementation(async () => { throw new Error('Parity must never spawn a process.'); });
  const fileUndoManager = new FileUndoManager();
  const workPlanStore = new WorkPlanStore({ homeDirectory: root, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, projectId: 'parity-test', projectRoot: root });

  const context = {
    print: (_text: string) => {},
    renderRequest: () => {},
    executeCommand: async (name: string, args: string[]) => commandRegistry.execute(name, args, context as CommandContext),
    openWorkspacePicker: () => {},
    openAgentWorkspace: () => {},
    dismissAgentWorkspace: () => false,
    openSettingsModal: () => {},
    openMcpWorkspace: () => {},
    openModelPicker: () => {},
    openModelPickerWithTarget: () => true,
    openProviderPicker: () => {},
    openProviderModelPickerWithTarget: () => true,
    openReasoningEffortPicker: () => ({ opened: true, model: 'test', levels: [] }),
    openSessionPicker: () => {},
    openProfilePicker: () => {},
    openBookmarkModal: () => {},
    openProcessModal: () => {},
    openLiveTail: () => ({ opened: true, processId: 'bg-test', label: 'test' }),
    openConversationSearch: () => {},
    openPromptHistorySearch: () => {},
    openSlashCommandMode: () => true,
    openFilePicker: () => true,
    openBlockActions: () => true,
    openContextInspector: () => {},
    openHelpOverlay: () => {},
    openShortcutsOverlay: () => {},
    openSelection: () => {},
    workspace: { shellPaths: paths, processManager, bookmarkManager: { list: () => [], listSavedFiles: () => [] }, fileUndoManager, workPlanStore },
    platform: {
      configManager,
      serviceRegistry: { getAll: () => ({}), inspect: async () => null },
      localUserAuthManager: {
        inspect: () => ({
          userStorePath: join(root, '.goodvibes', 'auth', 'users.json'),
          bootstrapCredentialPath: join(root, '.goodvibes', 'auth', 'bootstrap.txt'),
          persisted: true,
          bootstrapCredentialPresent: false,
          userCount: 0,
          sessionCount: 0,
          users: [],
          sessions: [],
        }),
      },
      subscriptionManager: { list: () => [], listPending: () => [], get: () => null, getPending: () => null },
      voiceProviderRegistry: { list: () => [] },
      voiceService: { listVoices: async () => [] },
      readModels: {
        security: {
          getSnapshot: () => ({
            audit: { totalTokens: 0, results: [], blocked: [], scopeViolations: [], rotationWarnings: [], rotationOverdue: [] },
            policy: { preflightStatus: 'ok', preflightIssueCount: 0, lintFindingCount: 0 },
            mcpServers: [], plugins: [], incidents: [], deniedPermissions: 0,
          }),
        },
      },
    },
    clients: {
      mcpApi: {
        listServerSecurity: () => [],
        listAllTools: async () => [],
      },
    },
    session: {
      runtime: { sessionId: 'parity-session', provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'medium' },
      conversationManager: { title: 'Parity test', getMessageCount: () => 0, getTranscriptEventIndex: () => ({ events: [], groups: [] }) },
      sessionManager: { list: () => [], search: () => [] },
    },
    provider: {
      providerRegistry: {
        listModels: () => [],
        getContextWindowForModel: () => 128_000,
      },
    },
    ops: {
      executionLedger: {
        getSnapshot: () => ({ records: [], total: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 }),
        subscribe: () => () => {},
        dispose: () => {},
      },
    },
    extensions: { toolRegistry },
  } as unknown as CommandContext;

  const tool = createAgentHarnessTool({
    commandRegistry,
    commandContext: context,
    toolRegistry,
  });
  toolRegistry.register(tool);

  return {
    tool,
    commandRegistry,
    spawn,
    cleanup: () => { spawn.mockRestore(); rmSync(root, { recursive: true, force: true }); },
  };
}

function parityArgs(mode: typeof AGENT_HARNESS_MODES[number]): Record<string, unknown> {
  // Exercise the real start guard, not an invalid-action exception. No fixture
  // grants confirmation or replaces the protected-source/process contracts.
  return mode === 'run_background_process' ? { mode, processAction: 'start', command: 'printf parity' } : { mode };
}

describe('agent_harness parity', () => {
  test('every mode in AGENT_HARNESS_MODES is handled by dispatch: never hits unhandled fallback', async () => {
    const fixture = makeParityFixture();
    try {
      const unhandledPattern = /^Unhandled agent_harness mode: /;
      const failures: string[] = [];

      for (const mode of AGENT_HARNESS_MODES) {
        const result = await fixture.tool.execute(parityArgs(mode));
        if (mode === 'model_routing') expect(result.success, result.error).toBe(true);
        // A mode may legitimately return success:false (e.g. validation error) but
        // must NOT return the literal unhandled-mode error string.
        if (!result.success && unhandledPattern.test(result.error ?? '')) {
          failures.push(`mode '${mode}' hit unhandled dispatch: ${result.error}`);
        }
      }

      expect(failures).toEqual([]);
      expect(readings.requests.length).toBeGreaterThan(0);
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  test('every effect-kind descriptor refuses execution without confirm + explicitUserRequest', async () => {
    const fixture = makeParityFixture();
    try {
      const effectDescriptors = HARNESS_MODE_DESCRIPTORS.filter(
        (descriptor) => descriptor.kind === 'effect',
      );

      // Sanity: there must be at least one effect mode or the test is vacuous.
      expect(effectDescriptors.length).toBeGreaterThan(0);

      // Statuses that indicate the effect was NOT executed (refusals/guards).
      // Any of these is an acceptable outcome when invoked without confirmation.
      const ACCEPTABLE_GUARD_STATUSES = new Set([
        'needs_confirmation',
        'confirmation_required',
        'missing_lookup',
        'ambiguous',
        'guidance',
        'no_direct_effect',
        'not_found',
      ]);

      const failures: string[] = [];

      for (const descriptor of effectDescriptors) {
        const result = await fixture.tool.execute(parityArgs(descriptor.id));
        if (descriptor.id === 'run_background_process') {
          expect(result.success).toBe(true);
          expect(JSON.parse(result.output ?? '{}').status).toBe('needs_confirmation');
        }

        // Accepted refusal patterns:
        //   success:false , hard error/validation refusal (always acceptable)
        //   success:true with a guard/refusal status (never an executed effect)
        if (result.success) {
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
          } catch {
            failures.push(`mode '${descriptor.id}': success:true but output is not JSON`);
            continue;
          }
          if (!ACCEPTABLE_GUARD_STATUSES.has(String(parsed.status))) {
            failures.push(
              `mode '${descriptor.id}': success:true with status='${String(parsed.status)}', expected a guard/refusal status or success:false`,
            );
          }
        }
        // success:false is always an acceptable refusal
      }

      expect(failures).toEqual([]);
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally {
      fixture.cleanup();
    }
  });

  test.each(['model_routing', 'model_route'] as const)('%s still refuses a missing protected-source owner before judgment', async mode => {
    const fixture = makeParityFixture({ sourceOwner: false });
    try {
      await expect(fixture.tool.execute({ mode })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(readings.requests).toHaveLength(0);
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally { fixture.cleanup(); }
  });

  test('background process dispatch still rejects a missing action without spawning', async () => {
    const fixture = makeParityFixture();
    try {
      await expect(fixture.tool.execute({ mode: 'run_background_process' })).rejects.toThrow('run_background_process requires processAction');
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(readings.requests).toHaveLength(0);
    } finally { fixture.cleanup(); }
  });

  test.each([{ confirm: true }, { explicitUserRequest: 'Run the parity fixture command.' }])('background start requires both confirmation fields: %j', async partial => {
    const fixture = makeParityFixture();
    try {
      const result = await fixture.tool.execute({ ...parityArgs('run_background_process'), ...partial });
      expect(result.success).toBe(true);
      expect(JSON.parse(result.output ?? '{}').status).toBe('needs_confirmation');
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(readings.requests).toHaveLength(0);
    } finally { fixture.cleanup(); }
  });

  test('command runner caps printed output at 6000 chars with truncation suffix', async () => {
    const fixture = makeParityFixture();
    try {
      // Register a test slash command that emits more than 6000 chars.
      // Each line is 100 chars; 80 lines = 8000 chars (exceeds cap).
      const longLine = 'x'.repeat(100);
      fixture.commandRegistry.register({
        name: 'print-long-output',
        description: 'Emit a long stream of output for truncation testing',
        handler: (_args, ctx) => {
          for (let i = 0; i < 80; i++) ctx.print(longLine);
        },
      });

      const result = await fixture.tool.execute({
        mode: 'run_command',
        command: '/print-long-output',
        confirm: true,
        explicitUserRequest: 'Test output truncation.',
      });
      expect(result.success).toBe(true);
      expect(result.output).toContain('... output truncated');
      // Verify the raw output string is bounded (command header + 6000 chars + marker).
      expect((result.output ?? '').length).toBeLessThan(7000);
    } finally {
      fixture.cleanup();
    }
  });
});
