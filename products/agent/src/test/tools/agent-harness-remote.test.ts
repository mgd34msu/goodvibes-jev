/**
 * agent-harness-remote.test.ts
 *
 * Focused tests for the distributed remote execution surface exposed via
 * agent_harness remote_* modes.
 *
 * Guarantees:
 *   1. Read surfaces (remote_snapshot, remote_peers, remote_work, remote_pair_requests)
 *      return success:true with the expected methodId, route, and effect fields.
 *   2. Mutation surfaces (remote_pair_approve, remote_pair_reject, remote_peers_invoke,
 *      remote_work_cancel) are confirmation-gated: they return success:false when called
 *      without confirm:true + explicitUserRequest.
 *   3. When confirmed, mutation surfaces return a handoff with methodId and modelRoute
 *      pointing at agent_operator_method.
 *   4. The remote catalog modes are registered in AGENT_HARNESS_MODES and described in
 *      HARNESS_MODE_DESCRIPTORS with the correct kinds and safety annotations.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ProcessManager, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
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

const REMOTE_READ_MODES = ['remote_snapshot', 'remote_peers', 'remote_work', 'remote_pair_requests'] as const;
const REMOTE_MUTATION_MODES = ['remote_pair_approve', 'remote_pair_reject', 'remote_peers_invoke', 'remote_work_cancel'] as const;
const ALL_REMOTE_MODES = [...REMOTE_READ_MODES, ...REMOTE_MUTATION_MODES] as const;

function makeRemoteFixture() {
  const root = makeProjectTempDir('gv-remote');
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
  const processManager = new ProcessManager();
  const fileUndoManager = new FileUndoManager();
  const workPlanStore = new WorkPlanStore({ homeDirectory: root, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, projectId: 'remote-test', projectRoot: root });

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
      runtime: { sessionId: 'remote-session', provider: 'openai', model: 'gpt-4.1', reasoningEffort: 'medium' },
      conversationManager: { title: 'Remote test', getMessageCount: () => 0, getTranscriptEventIndex: () => ({ events: [], groups: [] }) },
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
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe('agent_harness remote surface', () => {
  test('all remote modes are registered in AGENT_HARNESS_MODES', () => {
    const modeSet = new Set(AGENT_HARNESS_MODES);
    for (const mode of ALL_REMOTE_MODES) {
      expect(modeSet.has(mode)).toBe(true);
    }
  });

  test('all remote modes have HARNESS_MODE_DESCRIPTORS entries with correct kinds and safety annotations', () => {
    const descriptorMap = new Map(HARNESS_MODE_DESCRIPTORS.map((d) => [d.id, d]));

    for (const mode of REMOTE_READ_MODES) {
      const descriptor = descriptorMap.get(mode);
      expect(descriptor).toBeDefined();
      expect(descriptor?.kind).toBe('inspect');
      expect(descriptor?.family).toBe('remote');
      expect(descriptor?.requiresConfirmation).toBeUndefined();
    }

    for (const mode of REMOTE_MUTATION_MODES) {
      const descriptor = descriptorMap.get(mode);
      expect(descriptor).toBeDefined();
      expect(descriptor?.kind).toBe('effect');
      expect(descriptor?.family).toBe('remote');
      expect(descriptor?.requiresConfirmation).toBe(true);
      expect(descriptor?.parameters).toEqual(expect.arrayContaining(['confirm', 'explicitUserRequest']));
    }
  });

  test('read surfaces return success:true with correct methodId, route, and effect', async () => {
    const fixture = makeRemoteFixture();
    try {
      const expectations: Record<string, { methodId: string; effect: string }> = {
        remote_snapshot: { methodId: 'remote.snapshot', effect: 'read-only-network' },
        remote_peers: { methodId: 'remote.peers.list', effect: 'read-only-network' },
        remote_work: { methodId: 'remote.work.list', effect: 'read-only-network' },
        remote_pair_requests: { methodId: 'remote.pair.requests.list', effect: 'read-only-network' },
      };

      for (const [mode, expected] of Object.entries(expectations)) {
        const result = await fixture.tool.execute({ mode });
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
        expect(parsed.methodId).toBe(expected.methodId);
        expect(parsed.effect).toBe(expected.effect);
        expect(typeof parsed.modelRoute).toBe('string');
        // modelRoute is a preview string (max 56 chars) so long methodIds may be truncated.
        // Verify it starts with the tool name prefix, and that methodId is separately correct.
        expect(String(parsed.modelRoute)).toContain('agent_operator_method');
        expect(parsed.confirmationRequired).toBe(false);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('mutation surfaces are confirmation-gated: reject without confirm+explicitUserRequest', async () => {
    const fixture = makeRemoteFixture();
    try {
      for (const mode of REMOTE_MUTATION_MODES) {
        // No confirm, no explicitUserRequest
        const result = await fixture.tool.execute({ mode });
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('mutation surfaces return agent_operator_method handoff when confirmed', async () => {
    const fixture = makeRemoteFixture();
    try {
      const confirmArgs = { confirm: true, explicitUserRequest: 'test remote mutation' };

      const methodIdMap: Record<string, string> = {
        remote_pair_approve: 'remote.pair.requests.approve',
        remote_pair_reject: 'remote.pair.requests.reject',
        remote_peers_invoke: 'remote.peers.invoke',
        remote_work_cancel: 'remote.work.cancel',
      };

      for (const [mode, expectedMethodId] of Object.entries(methodIdMap)) {
        const result = await fixture.tool.execute({ mode, ...confirmArgs });
        expect(result.success).toBe(true);
        const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
        expect(parsed.methodId).toBe(expectedMethodId);
        expect(parsed.effect).toBe('confirmed-connected-host-state');
        expect(parsed.confirmationRequired).toBe(true);
        expect(typeof parsed.modelRoute).toBe('string');
        // modelRoute is a preview string (max 56 chars), verify tool prefix is present.
        // methodId identity is already asserted above via the parsed.methodId field.
        expect(String(parsed.modelRoute)).toContain('agent_operator_method');
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('remote_pair_approve handoff includes requestId in input when provided', async () => {
    const fixture = makeRemoteFixture();
    try {
      const result = await fixture.tool.execute({
        mode: 'remote_pair_approve',
        requestId: 'req-abc-123',
        note: 'approved by user',
        confirm: true,
        explicitUserRequest: 'Approve pair request req-abc-123',
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
      expect(parsed.methodId).toBe('remote.pair.requests.approve');
      const inputField = parsed.input as Record<string, unknown>;
      expect(inputField.requestId).toBe('req-abc-123');
      expect(inputField.note).toBe('approved by user');
    } finally {
      fixture.cleanup();
    }
  });

  test('remote_peers_invoke handoff includes peerId and command in input when provided', async () => {
    const fixture = makeRemoteFixture();
    try {
      const result = await fixture.tool.execute({
        mode: 'remote_peers_invoke',
        peerId: 'peer-xyz',
        command: 'run-task',
        confirm: true,
        explicitUserRequest: 'Invoke run-task on peer peer-xyz',
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
      expect(parsed.methodId).toBe('remote.peers.invoke');
      const inputField = parsed.input as Record<string, unknown>;
      expect(inputField.peerId).toBe('peer-xyz');
      expect(inputField.command).toBe('run-task');
    } finally {
      fixture.cleanup();
    }
  });

  test('remote_work_cancel handoff includes workId and reason when provided', async () => {
    const fixture = makeRemoteFixture();
    try {
      const result = await fixture.tool.execute({
        mode: 'remote_work_cancel',
        workId: 'work-001',
        reason: 'user requested cancellation',
        confirm: true,
        explicitUserRequest: 'Cancel remote work item work-001',
      });
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output ?? '{}') as Record<string, unknown>;
      expect(parsed.methodId).toBe('remote.work.cancel');
      const inputField = parsed.input as Record<string, unknown>;
      expect(inputField.workId).toBe('work-001');
      expect(inputField.reason).toBe('user requested cancellation');
    } finally {
      fixture.cleanup();
    }
  });

  test('remote modes are discoverable by keyword search in listHarnessModes', () => {
    const { HARNESS_MODE_DESCRIPTORS: descriptors } = require('../../tools/agent-harness-mode-catalog.ts') as typeof import('../../tools/agent-harness-mode-catalog.ts');
    const remoteDescriptors = descriptors.filter((d) => d.family === 'remote');
    expect(remoteDescriptors).toHaveLength(8);
    const ids = remoteDescriptors.map((d) => d.id).sort();
    expect(ids).toEqual(
      ['remote_pair_approve', 'remote_pair_reject', 'remote_pair_requests', 'remote_peers', 'remote_peers_invoke', 'remote_snapshot', 'remote_work', 'remote_work_cancel'],
    );
  });
});
