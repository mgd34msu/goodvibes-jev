import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { buildTestModelDefinition } from '../helpers/test-managers.ts';
import type { ModelFacts, ModelTierStore, TierRecord } from '@goodvibes-jev/engine/sdk/platform/routing';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { securityPort } from '../helpers/security-readings.ts';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ProcessManager, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { FileUndoManager, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, type MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { createLocalMemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentBrowserTool } from '../../tools/agent-browser-tool.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { registerScheduleRuntimeCommands } from '../../input/commands/schedule-runtime.ts';
import { CONFIG_SCHEMA, ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { buildGoodVibesSecretKey, buildGoodVibesSecretRef } from '../../config/secret-config.ts';
import { isAgentHiddenSettingKey } from '../../config/agent-settings-policy.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { registerOperatorRuntimeCommands } from '../../input/commands/operator-runtime.ts';
import { AGENT_WORKSPACE_CATEGORIES } from '../../input/agent-workspace-categories.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { describeCliCommandPolicy, describeCommandPolicy } from '../../tools/agent-harness-metadata.ts';
import { createAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { createAgentDocumentsTool } from '../../tools/agent-documents-tool.ts';
import { createAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { createAgentWorkspaceTool } from '../../tools/agent-workspace-tool.ts';
import { registerAgentTerminalProcessTools } from '../../tools/agent-terminal-process-tools.ts';
import { createAgentLocalRegistryTool } from '../../tools/agent-local-registry-tool.ts';
import { createAgentResearchReportTool } from '../../tools/agent-research-report-tool.ts';
import { createAgentReviewPacketPresetsTool } from '../../tools/agent-review-packet-presets-tool.ts';
import { createAgentReviewPacketShareTool } from '../../tools/agent-review-packet-share-tool.ts';
import { createAgentResearchRunsTool } from '../../tools/agent-research-runs-tool.ts';
import { createAgentResearchSourcesTool } from '../../tools/agent-research-sources-tool.ts';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { recordAgentChannelDeliveryReceipt } from '../../agent/channel-delivery-receipts.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentPromptContextReceiptStore } from '../../agent/prompt-context-receipts.ts';
import { AgentResearchRunRegistry } from '../../agent/research-run-registry.ts';
import { AgentResearchSourceRegistry } from '../../agent/research-source-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import { listGoodVibesCliCommands } from '../../cli/parser.ts';
import { compactRegisteredToolDefinitions } from '../../tools/tool-definition-compaction.ts';
import type { AgentExecutionRecord } from '../../runtime/execution-ledger.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

afterAll(cleanupResearchScreeningFixtures);

type ShellPaths = ReturnType<typeof createShellPathService>;
type HarnessOpenSelection = NonNullable<CommandContext['openSelection']>;

interface HarnessFixture {
  readonly root: string;
  readonly paths: ShellPaths;
  readonly commandRegistry: CommandRegistry;
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager | null;
  readonly keybindingsManager: KeybindingsManager;
  readonly toolRegistry: ToolRegistry;
  readonly processManager: ProcessManager;
  readonly tool: ReturnType<typeof createAgentHarnessTool>;
  readonly context: CommandContext;
  readonly printed: string[];
  readonly openedSurfaces: Array<{ readonly id: string; readonly detail?: string; readonly result?: boolean }>;
  readonly openedSelections: Array<{ readonly title: string; readonly itemIds: readonly string[]; readonly preSelectId?: string }>;
  readonly executionRecords: AgentExecutionRecord[];
  readonly cleanup: () => void;
}

function makeShellPaths(): { readonly root: string; readonly paths: ShellPaths; readonly cleanup: () => void } {
  const root = makeProjectTempDir('goodvibes-agent-harness-tool');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  return {
    root,
    paths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function makeConfig(paths: ShellPaths): ConfigManager {
  return new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
}

function createHarnessArtifactStore() {
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const store: Pick<ArtifactStore, 'create' | 'get' | 'list' | 'readContent'> = {
    async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
      const id = `artifact-${records.length + 1}`;
      const buffer = Buffer.from(input.text ?? '', 'utf-8');
      const record: ArtifactRecord = {
        id,
        kind: input.kind ?? 'data',
        mimeType: input.mimeType ?? 'text/plain',
        ...(input.filename ? { filename: input.filename } : {}),
        sizeBytes: buffer.byteLength,
        sha256: `sha-${records.length + 1}`,
        createdAt: Date.now() + records.length,
        acquisitionMode: input.acquisitionMode ?? 'inline-data',
        fetchMode: input.fetchMode ?? 'not-applicable',
        metadata: input.metadata ?? {},
        contentPath: `/tmp/${id}.data`,
        metadataPath: `/tmp/${id}.json`,
      };
      records.push(record);
      contents.set(id, buffer);
      return record;
    },
    get(id: string): ArtifactDescriptor | null {
      return records.find((record) => record.id === id) ?? null;
    },
    list(limit = 100): ArtifactDescriptor[] {
      return [...records].reverse().slice(0, limit);
    },
    async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
      const record = records.find((entry) => entry.id === id);
      const buffer = contents.get(id);
      if (!record || !buffer) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer };
    },
  };
  return { records, store };
}

function makeFixture(options: {
  readonly secrets?: boolean;
  readonly dismissAgentWorkspace?: boolean;
  readonly keybindings?: boolean;
  readonly builtinCommands?: boolean;
  readonly controlPlaneEnabled?: boolean;
  readonly controlPlanePort?: number;
  readonly artifactStore?: Pick<ArtifactStore, 'create' | 'get' | 'list' | 'readContent'>;
} = {}): HarnessFixture {
  const { root, paths, cleanup } = makeShellPaths();
  const commandRegistry = new CommandRegistry();
  const configManager = makeConfig(paths);
  if (options.controlPlaneEnabled !== undefined) configManager.set('controlPlane.enabled', options.controlPlaneEnabled);
  if (options.controlPlanePort !== undefined) configManager.set('controlPlane.port', options.controlPlanePort);
  const secretsManager = options.secrets === false
    ? null
    : new SecretsManager({ projectRoot: root, globalHome: root, configManager });
  const keybindingsManager = new KeybindingsManager({
    configPath: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'keybindings.json'),
  });
  const toolRegistry = new ToolRegistry();
  bindAgentResearchSourceOwner(toolRegistry, ordinaryResearchOwner());
  const processManager = new ProcessManager();
  const fixtureModel = { ...buildTestModelDefinition('openai', 'gpt-4.1'), contextWindow: 128_000 };
  const tierReading = { tier: 'standard', frontier: 0.01, small: 0.01 } satisfies TierRecord;
  const modelTiers = {
    read: async (facts: ModelFacts, options?: { site?: string; signal?: AbortSignal }) => {
      expect(facts.registryKey).toBe(fixtureModel.registryKey);
      expect(options?.site).toBe('agent.prompt-context-inspection');
      options?.signal?.throwIfAborted();
      return tierReading;
    },
  } satisfies Pick<ModelTierStore, 'read'>;
  const fileUndoManager = new FileUndoManager();
  const workPlanStore = new WorkPlanStore({ homeDirectory: root, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, projectId: 'harness-test', projectRoot: root });
  const printed: string[] = [];
  const openedSurfaces: Array<{ readonly id: string; readonly detail?: string; readonly result?: boolean }> = [];
  const openedSelections: Array<{ readonly title: string; readonly itemIds: readonly string[]; readonly preSelectId?: string }> = [];
  const executionRecords: AgentExecutionRecord[] = [];
  const savedSessions = [{
    name: 'session-alpha',
    title: 'Alpha planning session',
    model: 'gpt-4.1',
    provider: 'openai',
    timestamp: 1_700_000_000_000,
    messageCount: 5,
    filePath: join(root, '.goodvibes', 'sessions', 'session-alpha.json'),
  }];
  const sessionManager = {
    list: () => savedSessions,
    search: (query: string) => savedSessions
      .filter((session) => [session.name, session.title, session.model, session.provider].join('\n').toLowerCase().includes(query.toLowerCase()))
      .map((session) => ({ session, matchCount: 1, snippets: [`${session.title} match`] })),
  };
  const bookmarkManager = {
    list: () => [{ id: 'bookmark-alpha' }],
    listSavedFiles: () => [{ path: join(root, 'bookmarks.md') }],
  };
  const openSelection: HarnessOpenSelection = (title, items, opts) => {
    openedSelections.push({
      title,
      itemIds: items.map((item) => item.id),
      preSelectId: opts?.preSelectId,
    });
  };

  if (options.builtinCommands === true) {
    registerBuiltinCommands(commandRegistry);
  } else {
    commandRegistry.register({
      name: 'brief',
      description: 'Test briefing command',
      handler: (_args, ctx) => {
        ctx.print('briefing output');
      },
    });
    commandRegistry.register({
      name: 'commands',
      description: 'Browse all commands in a scrollable list',
      handler: (_args, ctx) => {
        ctx.openSelection?.(
          'Help - Commands',
          [{ id: '/brief', label: '/brief', detail: 'Test briefing command' }],
          { allowSearch: true },
          () => {},
        );
      },
    });
  }

  const context = {
    print: (text: string) => printed.push(text),
    renderRequest: () => {},
    executeCommand: async (name: string, args: string[]) => commandRegistry.execute(name, args, context as CommandContext),
    openWorkspacePicker: () => {
      openedSurfaces.push({ id: 'panel-picker', detail: 'home' });
    },
    openAgentWorkspace: (categoryId?: string) => {
      openedSurfaces.push({ id: 'agent-workspace', detail: categoryId });
    },
    dismissAgentWorkspace: () => {
      const result = options.dismissAgentWorkspace === true;
      openedSurfaces.push({ id: 'agent-workspace-dismissed', result });
      return result;
    },
    openSettingsModal: (target?: string) => {
      openedSurfaces.push({ id: 'settings', detail: target });
    },
    openMcpWorkspace: () => {
      openedSurfaces.push({ id: 'mcp-workspace' });
    },
    openModelPicker: () => {
      openedSurfaces.push({ id: 'model-picker' });
    },
    openModelPickerWithTarget: (target: string) => {
      openedSurfaces.push({ id: 'model-picker', detail: target, result: true });
      return true;
    },
    openProviderPicker: () => {
      openedSurfaces.push({ id: 'provider-picker' });
    },
    openProviderModelPickerWithTarget: (target: string) => {
      openedSurfaces.push({ id: 'provider-picker', detail: target });
      return true;
    },
    openReasoningEffortPicker: () => {
      openedSelections.push({
        title: 'Reasoning Effort',
        itemIds: ['low', 'medium', 'high'],
        preSelectId: 'medium',
      });
      return { opened: true, model: 'Reasoning Model', levels: ['low', 'medium', 'high'] };
    },
    openSessionPicker: () => {
      openedSurfaces.push({ id: 'session-picker' });
    },
    openProfilePicker: () => {
      openedSurfaces.push({ id: 'profile-picker' });
    },
    openBookmarkModal: () => {
      openedSurfaces.push({ id: 'bookmark-modal' });
    },
    openProcessModal: () => {
      openedSurfaces.push({ id: 'process-monitor' });
    },
    openLiveTail: (target?: string) => {
      openedSurfaces.push({ id: 'live-tail', detail: target ?? 'selected' });
      return { opened: true, processId: 'bg-test', label: 'sleep 5' };
    },
    openConversationSearch: (query?: string) => {
      openedSurfaces.push({ id: 'conversation-search', detail: query });
    },
    openPromptHistorySearch: (query?: string) => {
      openedSurfaces.push({ id: 'prompt-history-search', detail: query });
    },
    openSlashCommandMode: (query?: string) => {
      openedSurfaces.push({ id: 'slash-command-mode', detail: query });
      return true;
    },
    openFilePicker: (options?: { injectMode?: boolean; query?: string }) => {
      openedSurfaces.push({
        id: 'file-picker',
        detail: `${options?.injectMode ? 'inject' : 'reference'}:${options?.query ?? ''}`,
      });
      return true;
    },
    openBlockActions: () => {
      openedSurfaces.push({ id: 'block-actions' });
      return true;
    },
    openContextInspector: () => {
      openedSurfaces.push({ id: 'context-inspector' });
    },
    openHelpOverlay: () => {
      openedSurfaces.push({ id: 'help-overlay' });
    },
    openShortcutsOverlay: () => {
      openedSurfaces.push({ id: 'shortcuts-overlay' });
    },
    openSelection,
    workspace: options.keybindings === false
      ? { shellPaths: paths, processManager, bookmarkManager, fileUndoManager, workPlanStore }
      : { shellPaths: paths, processManager, keybindingsManager, bookmarkManager, fileUndoManager, workPlanStore },
    platform: {
      configManager,
      serviceRegistry: {
        getAll: () => ({}),
        inspect: async () => null,
      },
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
      subscriptionManager: {
        list: () => [],
        listPending: () => [],
        get: () => null,
        getPending: () => null,
      },
      voiceProviderRegistry: {
        list: () => [
          { id: 'stream-voice', label: 'Streaming Voice', capabilities: ['tts-stream'] },
          { id: 'non-stream-voice', label: 'Non Streaming Voice', capabilities: [] },
        ],
      },
      voiceService: {
        listVoices: async (providerId?: string) => [
          { id: `${providerId ?? 'default'}-voice-a`, label: 'Voice A' },
          { id: `${providerId ?? 'default'}-voice-b`, label: 'Voice B' },
        ],
      },
      ...(options.artifactStore ? { artifactStore: options.artifactStore } : {}),
      readModels: {
        security: {
          getSnapshot: () => ({
            audit: {
              totalTokens: 1,
              results: [{
                label: 'agent-token',
                blocked: true,
                scope: { outcome: 'violation', policyId: 'agent-policy' },
                rotation: { outcome: 'ok' },
              }],
              blocked: ['agent-token'],
              scopeViolations: ['agent-token'],
              rotationWarnings: [],
              rotationOverdue: [],
            },
            policy: {
              preflightStatus: 'ok',
              preflightIssueCount: 0,
              lintFindingCount: 0,
            },
            mcpServers: [],
            plugins: [],
            incidents: [],
            deniedPermissions: 0,
          }),
        },
      },
      ...(secretsManager ? { secretsManager } : {}),
    },
    clients: {
      mcpApi: {
        listServerSecurity: () => [{
          name: 'filesystem',
          connected: true,
          trustMode: 'constrained',
          role: 'tools',
          schemaFreshness: 'fresh',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [root],
          allowedHosts: ['localhost'],
        }],
        listAllTools: async () => [{
          serverName: 'filesystem',
          toolName: 'read_file',
          description: 'Read a file from an allowed path.',
        }],
      },
    },
    session: {
      runtime: {
        sessionId: 'session-alpha',
        provider: 'openai',
        model: 'gpt-4.1',
        reasoningEffort: 'medium',
      },
      conversationManager: {
        title: 'Alpha planning session',
        getMessageCount: () => 5,
        getTranscriptEventIndex: () => ({ events: [], groups: [] }),
      },
      sessionManager,
    },
    provider: {
      providerRegistry: {
        listModels: () => [{ provider: 'openai', modelId: 'gpt-4.1', providerEnvVars: ['OPENAI_API_KEY'] }],
        getContextWindowForModel: () => 128_000,
        getCurrentModel: () => fixtureModel,
        resolveModelPricing: () => ({ status: 'unknown' }),
        modelTiers,
      },
    },
    ops: {
      executionLedger: {
        getSnapshot: () => ({
          records: executionRecords,
          total: executionRecords.length,
          running: executionRecords.filter((record) => record.status === 'running').length,
          succeeded: executionRecords.filter((record) => record.status === 'succeeded').length,
          failed: executionRecords.filter((record) => record.status === 'failed').length,
          cancelled: executionRecords.filter((record) => record.status === 'cancelled').length,
        }),
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
  registerAgentTerminalProcessTools(toolRegistry, context);

  return {
    root,
    paths,
    commandRegistry,
    configManager,
    secretsManager,
    keybindingsManager,
    toolRegistry,
    processManager,
    tool,
    context,
    printed,
    openedSurfaces,
    openedSelections,
    executionRecords,
    cleanup: () => {
      for (const entry of processManager.list()) processManager.stop(entry.id);
      cleanup();
    },
  };
}

async function createMemoryRegistry(paths: ShellPaths, configManager: ConfigManager): Promise<MemoryRegistry> {
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return new MemoryRegistry(store);
}

function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: 'mem-briefing',
    scope: 'project',
    cls: 'fact',
    summary: 'Prefers concise briefings',
    detail: 'Lead with status, then next action.',
    tags: ['briefing'],
    provenance: [],
    reviewState: 'reviewed',
    confidence: 92,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function attachMemoryApi(fixture: HarnessFixture, records: readonly MemoryRecord[] = [makeMemoryRecord()]): void {
  const mutableRecords = [...records];
  const vector = {
    backend: 'sqlite-vec' as const,
    enabled: true,
    available: true,
    path: fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.vec.sqlite'),
    dimensions: 384,
    indexedRecords: mutableRecords.length,
    embeddingProviderId: 'hashed-local',
    embeddingProviderLabel: 'Hashed Local',
  };
  const memory = {
    getAll: () => mutableRecords,
    reviewQueue: () => mutableRecords.filter((record) => record.reviewState !== 'reviewed'),
    vectorStats: () => vector,
    doctor: async () => ({
      vector,
      embeddings: {
        activeProviderId: 'hashed-local',
        providers: [{
          id: 'hashed-local',
          label: 'Hashed Local',
          state: 'healthy',
          dimensions: 384,
          configured: true,
          deterministic: true,
          metadata: { local: true, hasSyncEmbed: true },
        }],
        asyncProviders: [],
        syncProviders: ['hashed-local'],
        warnings: [],
      },
      checkedAt: Date.now(),
    }),
  };
  (fixture.context as unknown as { clients: { agentKnowledgeApi?: unknown } }).clients.agentKnowledgeApi = { memory };
}

function registerStubTool(toolRegistry: ToolRegistry, name: string): void {
  const tool: Tool = {
    definition: {
      name,
      description: `${name} test tool`,
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    execute: async () => ({ success: true, output: `${name} executed` }),
  };
  toolRegistry.register(tool);
}

function fakeChannelDeliveryRouter(requests: ChannelDeliveryRequest[]) {
  return {
    listStrategies: () => [{ id: 'fake-channel', canHandle: () => true, deliver: async () => ({}) }],
    deliver: async (request: ChannelDeliveryRequest) => {
      requests.push(request);
      return 'harness-channel-response-1';
    },
  };
}

function readAuthorizationHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('authorization');
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === 'authorization');
    return entry ? String(entry[1]) : null;
  }
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  return typeof value === 'string' ? value : null;
}

function expectModelFacingText(output: string): void {
  const forbidden = [
    ['commandContext', '.'].join(''),
    ['legacy', 'panel'].join(' '),
    ['legacy', 'panels'].join(' '),
    ['shell', 'bridge'].join(' '),
    ['focus', 'Prompt'].join(''),
  ];
  for (const token of forbidden) {
    expect(output).not.toContain(token);
  }
}

function expectCompactSummaryFields(value: unknown, limit = 72): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) expectCompactSummaryFields(entry, limit);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'summary' && typeof entry === 'string') {
      expect(entry.length).toBeLessThanOrEqual(limit);
    }
    expectCompactSummaryFields(entry, limit);
  }
}

function expectCompactModelRoute(value: unknown): void {
  expect(typeof value).toBe('string');
  const route = String(value);
  expect(route.length).toBeGreaterThan(0);
  expect(route.length).toBeLessThanOrEqual(72);
}

function expectRowsHaveCompactModelRoutes(rows: readonly Record<string, unknown>[]): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expectCompactModelRoute(row.modelRoute);
}

async function executeHarnessJson<T>(fixture: HarnessFixture, args: Record<string, unknown>): Promise<T> {
  const result = await fixture.tool.execute(args);
  expect(result.success, result.error).toBe(true);
  if (!result.success) throw new Error(result.error);
  return JSON.parse(result.output ?? '{}') as T;
}

const CONNECTED_HOST_AUTH_ENV_KEYS = [
  'GOODVIBES_CONNECTED_HOST_TOKEN',
  'GOODVIBES_DAEMON_TOKEN',
] as const;

const PROVIDER_AUTH_ENV_KEYS = [
  'OPENAI_API_KEY',
  'OPENAI_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GEMINI_API_KEY',
  'INCEPTION_API_KEY',
  'OPENROUTER_API_KEY',
  'AIHUBMIX_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'MISTRAL_API_KEY',
  'OLLAMA_CLOUD_API_KEY',
  'OLLAMA_API_KEY',
  'HF_API_KEY',
  'HUGGINGFACE_API_KEY',
  'HF_TOKEN',
  'NVIDIA_API_KEY',
  'LLM7_API_KEY',
  'DEEPSEEK_API_KEY',
  'FIREWORKS_API_KEY',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'AZURE_OPENAI_API_KEY',
  'MINIMAX_API_KEY',
  'MOONSHOT_API_KEY',
  'QIANFAN_API_KEY',
  'QWEN_API_KEY',
  'DASHSCOPE_API_KEY',
  'MODELSTUDIO_API_KEY',
  'SGLANG_API_KEY',
  'STEPFUN_API_KEY',
  'TOGETHER_API_KEY',
  'VENICE_API_KEY',
  'VOLCANO_ENGINE_API_KEY',
  'XAI_API_KEY',
  'XIAOMI_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  'AI_GATEWAY_API_KEY',
  'LITELLM_API_KEY',
  'COPILOT_PROXY_API_KEY',
] as const;

const LOCAL_MODEL_ENDPOINT_ENV_KEYS = [
  'OLLAMA_BASE_URL',
  'OLLAMA_HOST',
  'LM_STUDIO_BASE_URL',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPAT_BASE_URL',
  'VLLM_BASE_URL',
  'LLAMA_CPP_BASE_URL',
  'LITELLM_BASE_URL',
] as const;

function clearEnvForTest(keys: readonly string[]): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  return previous;
}

function restoreEnvForTest(previous: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function withClearedEnv<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const previous = clearEnvForTest(keys);
  try {
    return await fn();
  } finally {
    restoreEnvForTest(previous);
  }
}

async function withTcpListener<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('TCP fixture did not receive an address.');
    return await fn((address as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function withPairedHost<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/api/control-plane/auth' || request.headers.get('authorization') !== 'Bearer fixture-connected-host-token') return new Response('unsupported fixture request', { status: 404 });
    return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: 'synthetic-paired-owner', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'write:work-ledger'], roles: [] });
  } });
  try { return await withClearedEnv(CONNECTED_HOST_AUTH_ENV_KEYS, () => fn(server.port!)); } finally { server.stop(true); }
}

function writeConnectedHostOperatorToken(fixture: HarnessFixture, token = 'fixture-connected-host-token'): void {
  writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), `${JSON.stringify({ token })}\n`, { mode: 0o600 });
}

describe('agent_harness tool', () => {
  let previousPort: JudgmentPort | undefined;
  beforeEach(() => {
    const security = securityPort();
    const credentials = fakePort((name, _question, state) => {
      if (name !== 'credential' || !state || typeof state !== 'object' || !('name' in state) || typeof state.name !== 'string') {
        throw new Error(`Unscripted harness process reading: ${name}`);
      }
      // Explicit test readings retain the real environment scrub: synthetic
      // credential-shaped names are withheld, ordinary fixture env passes.
      return noulAnswer(/key|token|secret|password|credential/i.test(state.name) ? 0.999 : 0.001);
    });
    // Explicit canonical PersonalOps readings. These fixtures are not lexical search rules.
    const personalOpsPicks: Readonly<Record<string, string>> = {
      'review-thread:artifact-1:msg-1': 'inbox:review-thread:artifact-1:msg-1',
      'Triage my unread inbox.': 'inbox-triage-briefing',
      'Triage my unread email.': 'inbox-triage-briefing',
      'Draft a reply to this email thread.': 'inbox-draft-reply',
      'Brief my calendar for today.': 'calendar-agenda-briefing',
      'Search and list email messages for triage. User request: Triage my unread email.': 'mcp:gmail-inbox:mcp:gmail-inbox:gmail.search_messages',
      'Read the selected email conversation to draft a reply. User request: Draft a reply to this email thread.': 'mcp:gmail-inbox:mcp:gmail-inbox:gmail.get_thread',
      'Send the reviewed reply only after separate confirmation. User request: Draft a reply to this email thread.': 'mcp:gmail-inbox:mcp:gmail-inbox:gmail.send_reply',
      'Edit the selected calendar event only after separate confirmation. User request: Brief my calendar for today.': '',
      'Read upcoming agenda events. User request: Brief my calendar for today.': 'mcp:caldav-agenda:mcp:caldav-agenda:caldav.list_events',
    };
    const personalOps = fakePort((_name, _question, rawState) => {
      const state = rawState as unknown as { query: string; candidate: { name: string } };
      const pick = personalOpsPicks[state.query];
      if (pick === undefined) throw new Error(`Unscripted PersonalOps fixture ${state.query}`);
      return noulAnswer(state.candidate.name === pick ? 0.95 : 0.01);
    });
    const lifetime = fakePort(() => noulAnswer(0.01));
    const port: JudgmentPort = {
      model: security.port.model,
      ask: request => request.context?.battery === 'agent.tools.long-lived-process' ? lifetime.port.ask(request)
        : request.context?.battery === 'engine.tools.registry-rank' ? personalOps.port.ask(request)
        : Object.keys(request.questions).length === 1 && Object.hasOwn(request.questions, 'credential')
        ? credentials.port.ask(request) : security.port.ask(request),
    };
    previousPort = installJudgmentPort(port);
  });
  afterEach(() => { installJudgmentPort(previousPort); });

  test('exposes a searchable compact harness mode catalog to the model', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary' });
      expect(summary.success, summary.error).toBe(true);
      if (!summary.success) throw new Error(summary.error);
      const summaryJson = JSON.parse(summary.output ?? '{}') as {
        readonly assistant?: {
          readonly status?: string;
          readonly primaryNextAction?: string;
          readonly boundaryPolicy?: string;
          readonly lanes?: readonly {
            readonly id: string;
            readonly label: string;
            readonly state: string;
            readonly routes: readonly string[];
          }[];
        };
        readonly harnessModes?: number;
        readonly modeGuide?: { readonly discover?: readonly string[]; readonly inspect?: readonly string[] };
      };
      expect(summaryJson.assistant?.status).toBeTruthy();
      expect(summaryJson.assistant?.primaryNextAction).toBeTruthy();
      expect(summaryJson.assistant?.boundaryPolicy).toContain('Primary UX is one assistant');
      expect(summaryJson.assistant?.lanes?.map((lane) => lane.id)).toEqual([
        'setup',
        'chat-and-model',
        'work-and-files',
        'personal-ops',
        'research-and-docs',
        'background-work',
        'safety-and-recovery',
      ]);
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'setup')?.routes.join('\n')).toContain('setup action:"status"');
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'setup')?.routes.join('\n')).toContain('setup action:"token"');
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'setup')?.routes.join('\n')).toContain('setup action:"smoke"');
      expect(summaryJson.assistant?.lanes?.find((lane) => lane.id === 'work-and-files')?.label).toBe('Work in this project');
      expect(summaryJson.harnessModes).toBeGreaterThan(60);
      expect(summaryJson.modeGuide?.discover).toContain('modes');
      expect(summaryJson.modeGuide?.discover).toContain('execution_posture');
      expect(summaryJson.modeGuide?.discover).toContain('execution_history');
      expect(summaryJson.modeGuide?.discover).toContain('file_recovery');
      expect(summaryJson.modeGuide?.discover).toContain('personal_ops');
      expect(summaryJson.modeGuide?.discover).toContain('autonomy_intake');
      expect(summaryJson.modeGuide?.discover).toContain('research_briefing');
      expect(summaryJson.modeGuide?.discover).toContain('research_runs');
      expect(summaryJson.modeGuide?.inspect).toContain('mode');
      expect(summaryJson.modeGuide?.inspect).toContain('execution_route');
      expect(summaryJson.modeGuide?.inspect).toContain('execution_history_item');
      expect(summaryJson.modeGuide?.inspect).toContain('personal_ops_lane');
      expect(summaryJson.modeGuide?.inspect).toContain('research_run');
      expect(summaryJson.modeGuide?.inspect).toContain('research_source');
      expect(summaryJson.modeGuide?.inspect).toContain('document_ops_lane');

      const allModes = await fixture.tool.execute({ mode: 'modes', limit: 500 });
      expect(allModes.success).toBe(true);
      if (!allModes.success) throw new Error(allModes.error);
      const allModesJson = JSON.parse(allModes.output ?? '{}') as {
        readonly modes: readonly { readonly summary?: string; readonly next?: string; readonly parameters?: readonly string[] }[];
      };
      expect(allModesJson.modes.length).toBe(summaryJson.harnessModes!);
      expect(allModesJson.modes.filter((entry) => (entry.summary?.length ?? 0) > 72)).toEqual([]);
      expect(allModesJson.modes.filter((entry) => (entry.next?.length ?? 0) > 72)).toEqual([]);
      expect(allModesJson.modes.filter((entry) => entry.parameters !== undefined)).toEqual([]);

      const settingsModes = await fixture.tool.execute({ mode: 'modes', query: 'settings' });
      expect(settingsModes.success).toBe(true);
      if (!settingsModes.success) throw new Error(settingsModes.error);
      const settingsJson = JSON.parse(settingsModes.output ?? '{}') as {
        readonly modes: readonly { readonly id: string; readonly parameters?: readonly string[] }[];
        readonly returned: number;
        readonly total: number;
      };
      expect(settingsJson.total).toBe(summaryJson.harnessModes!);
      expect(settingsJson.returned).toBeGreaterThan(0);
      expect(settingsJson.modes.map((entry) => entry.id)).toEqual(expect.arrayContaining([
        'settings',
        'get_setting',
        'set_setting',
        'reset_setting',
      ]));
      expect(settingsJson.modes.filter((entry) => entry.parameters !== undefined)).toEqual([]);

      const personalModes = await fixture.tool.execute({ mode: 'modes', query: 'personal operations' });
      expect(personalModes.success).toBe(true);
      expect(personalModes.output).toContain('personal_ops');

      const autonomyModes = await fixture.tool.execute({ mode: 'modes', query: 'ongoing-work' });
      expect(autonomyModes.success).toBe(true);
      expect(autonomyModes.output).toContain('autonomy_intake');

      const executionModes = await fixture.tool.execute({ mode: 'modes', query: 'local shell execution' });
      expect(executionModes.success).toBe(true);
      expect(executionModes.output).toContain('execution_posture');

      const recoveryModes = await fixture.tool.execute({ mode: 'modes', query: 'file edit undo recovery' });
      expect(recoveryModes.success).toBe(true);
      const recoveryModesJson = JSON.parse(recoveryModes.output ?? '{}') as {
        readonly modes: readonly { readonly id: string; readonly next?: string }[];
      };
      expect(recoveryModesJson.modes[0]?.id).toBe('file_recovery');
      expect(recoveryModesJson.modes[0]?.next).toContain('execution action:"recovery"');

      const historyModes = await fixture.tool.execute({ mode: 'modes', query: 'execution history record' });
      expect(historyModes.success).toBe(true);
      const historyModesJson = JSON.parse(historyModes.output ?? '{}') as {
        readonly modes: readonly { readonly id: string; readonly next?: string }[];
      };
      expect(historyModesJson.modes.map((mode) => mode.id)).toContain('execution_history');
      expect(historyModesJson.modes.find((mode) => mode.id === 'execution_history')?.next).toContain('execution action:"history"');

      const documentModes = await fixture.tool.execute({ mode: 'modes', query: 'blind model comparison documents uploads' });
      expect(documentModes.success).toBe(true);
      expect(documentModes.output).toContain('document_ops');

      const detailedModes = await fixture.tool.execute({
        mode: 'modes',
        query: 'settings',
        includeParameters: true,
        limit: 1,
      });
      expect(detailedModes.success).toBe(true);
      if (!detailedModes.success) throw new Error(detailedModes.error);
      expect(detailedModes.output).toContain('"parameters"');
      expectModelFacingText(allModes.output!);
      expectModelFacingText(detailedModes.output!);

      const taskPhrase = await fixture.tool.execute({ mode: 'modes', query: 'set setting' });
      expect(taskPhrase.success).toBe(true);
      if (!taskPhrase.success) throw new Error(taskPhrase.error);
      const taskPhraseJson = JSON.parse(taskPhrase.output ?? '{}') as {
        readonly modes: readonly { readonly id: string }[];
      };
      expect(taskPhraseJson.modes[0]?.id).toBe('set_setting');
      expect(taskPhraseJson.modes.map((entry) => entry.id)).toContain('set_setting');

      const setSetting = await fixture.tool.execute({ mode: 'mode', target: 'set_setting' });
      expect(setSetting.success).toBe(true);
      if (!setSetting.success) throw new Error(setSetting.error);
      const setSettingJson = JSON.parse(setSetting.output ?? '{}') as {
        readonly id: string;
        readonly kind: string;
        readonly family: string;
        readonly requiresConfirmation?: boolean;
        readonly parameters?: readonly string[];
        readonly lookup?: { readonly resolvedBy?: string };
      };
      expect(setSettingJson).toMatchObject({
        id: 'set_setting',
        kind: 'effect',
        family: 'settings',
        requiresConfirmation: true,
      });
      expect(setSettingJson.parameters).toEqual(expect.arrayContaining(['key', 'value', 'confirm', 'explicitUserRequest']));
      expect(setSettingJson.lookup?.resolvedBy).toBe('id');

      const missing = await fixture.tool.execute({ mode: 'mode' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('mode inspection requires target or query');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a prioritized first-run setup plan with route-backed next actions', async () => {
    const fixture = makeFixture();
    try {
      const summary = await executeHarnessJson<{
        readonly setupPosture?: {
          readonly planItems?: number;
          readonly blockedPlanItems?: number;
          readonly autonomyBlockers?: number;
          readonly nextSetupHandoffs?: readonly {
            readonly setupItemId: string;
            readonly handoffRoute?: string;
            readonly handoffKind?: string;
            readonly requiresConfirmation?: boolean;
          }[];
          readonly setupWizard?: {
            readonly status: string;
            readonly completedSteps: number;
            readonly totalSteps: number;
            readonly currentStepId: string;
            readonly currentStepLabel: string;
            readonly reviewRoute: string;
          };
          readonly setupCloseout?: {
            readonly status: string;
            readonly primaryStepId: string | null;
            readonly modelRoute: string;
            readonly requiresConfirmation: boolean;
          };
        };
      }>(fixture, { mode: 'summary', includeParameters: true });
      expect(summary.setupPosture?.planItems).toBeGreaterThanOrEqual(7);
      expect(typeof summary.setupPosture?.blockedPlanItems).toBe('number');
      expect(summary.setupPosture?.autonomyBlockers).toBeGreaterThanOrEqual(1);
      expect(summary.setupPosture?.nextSetupHandoffs?.[0]?.setupItemId).toBe('connected-host-readiness');
      expect(summary.setupPosture?.nextSetupHandoffs?.[0]?.handoffRoute).toContain('host action:"status"');
      expect(summary.setupPosture?.setupWizard?.status).toBe('blocked');
      expect(summary.setupPosture?.setupWizard?.currentStepId).toBe('connected-host-auth');
      expect(summary.setupPosture?.setupWizard?.currentStepLabel).toBe('Connected-host auth');
      expect(summary.setupPosture?.setupWizard?.reviewRoute).toContain('setup action:"status"');
      expect(summary.setupPosture?.setupCloseout).toMatchObject({
        status: 'blocked',
        primaryStepId: 'connected-host-auth',
        requiresConfirmation: false,
      });
      expect(summary.setupPosture?.setupCloseout?.modelRoute).toContain('setup action:"token"');

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly readinessPlan: {
            readonly blocked: number;
            readonly check: number;
            readonly blocksAutonomy: number;
          };
        };
        readonly setupWizard: {
          readonly status: string;
          readonly completedSteps: number;
          readonly totalSteps: number;
          readonly currentStepId: string;
          readonly currentStepLabel: string;
          readonly progressLabel: string;
          readonly next: string;
          readonly _diagnostic: {
            readonly closeout: {
              readonly status: string;
              readonly label: string;
              readonly summary: string;
              readonly primaryStepId: string | null;
              readonly primaryStepLabel: string | null;
              readonly modelRoute: string;
              readonly userRoute: string;
              readonly requiresConfirmation: boolean;
              readonly evidence: readonly string[];
            };
            readonly smokeHistory: { readonly status: string; readonly total: number; readonly rerunRoute: string; readonly saveRoute: string };
          };
          readonly steps: readonly { readonly id: string; readonly status: string; readonly modelRoute: string; readonly backtrackRoute?: string | null }[];
        };
        readonly setupCloseout: {
          readonly status: string;
          readonly primaryStepId: string | null;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
        };
        readonly readinessPlan: readonly {
          readonly setupItemId: string;
          readonly status: string;
          readonly priority: number;
          readonly blocksAutonomy: boolean;
          readonly nextAction: string;
          readonly userRoute: string;
          readonly modelRoute: string;
          readonly primaryHandoff?: {
            readonly id: string;
            readonly label: string;
            readonly kind: string;
            readonly effect: string;
            readonly userRoute: string;
            readonly modelRoute: string;
            readonly nextStep: string;
            readonly safety: string;
            readonly requiresConfirmation?: boolean;
          };
          readonly handoffs?: readonly {
            readonly id: string;
            readonly kind: string;
            readonly effect: string;
            readonly modelRoute: string;
            readonly requiresConfirmation?: boolean;
          }[];
          readonly signals?: readonly string[];
          readonly availableRepairCards?: readonly string[];
          readonly bootstrapRoute?: string;
          readonly repairCards?: readonly {
            readonly id: string;
            readonly state: string;
            readonly effect: string;
            readonly methodId?: string;
            readonly modelRoute?: string;
            readonly prerequisite?: string;
            readonly recommendedWhen: string;
            readonly safety: string;
          }[];
          readonly serviceLifecycleDecision?: {
            readonly status: string;
            readonly recommendedAction: string;
            readonly modelRoute: string;
            readonly reason: string;
            readonly evidence: {
              readonly probeStatus: string;
              readonly serviceStatusMethodPublished: boolean;
            };
            readonly receiptRules: readonly string[];
            readonly blockedMutations: readonly string[];
          };
          readonly bootstrapPlan?: {
            readonly status: string;
            readonly source: string;
            readonly recommendedWhen: string;
            readonly steps: readonly {
              readonly id: string;
              readonly commands: readonly string[];
              readonly fallback?: string;
            }[];
            readonly reconnectRoutes: { readonly agentStatus: string; readonly serviceDiagnostics: string; readonly setupItem: string };
            readonly policy: string;
          };
          readonly installSmokePlan?: {
            readonly status: string;
            readonly source: string;
            readonly checks: readonly { readonly id: string; readonly status: string; readonly route: string; readonly evidence: string }[];
            readonly successCriteria: readonly string[];
            readonly policy: string;
          };
          readonly localModelReadiness?: {
            readonly cookbookStatus: string;
            readonly inspectRoute: string;
            readonly inspectRecipeRoute: string;
            readonly readinessRubric?: {
              readonly dimensions: readonly { readonly id: string; readonly weight: number }[];
            };
            readonly topRecipe?: {
              readonly id: string;
              readonly readinessScore?: number | null;
              readonly setupStatus?: string;
            };
            readonly nextActions?: readonly string[];
          };
          readonly sudoPosture?: {
            readonly status: string;
            readonly setupStatus: string;
            readonly setupRoute: string;
            readonly credentialSignal: {
              readonly envPresent: boolean;
              readonly checked: string;
              readonly rawValueReturned: boolean;
              readonly valueUsableForBackgroundProcess: boolean;
            };
            readonly blockedRoutes: readonly { readonly id: string; readonly reason: string }[];
            readonly missingContracts: readonly string[];
            readonly policy: string;
          };
        }[];
        readonly nextSetupActions: readonly {
          readonly setupItemId: string;
          readonly status: string;
          readonly modelRoute: string;
          readonly handoffLabel?: string;
          readonly handoffKind?: string;
          readonly handoffRoute?: string;
          readonly handoffUserRoute?: string;
          readonly requiresConfirmation?: boolean;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'setup_posture', includeParameters: true });

      expect(typeof posture.summary.readinessPlan.blocked).toBe('number');
      expect(posture.summary.readinessPlan.check).toBeGreaterThanOrEqual(1);
      expect(posture.summary.readinessPlan.blocksAutonomy).toBeGreaterThanOrEqual(1);
      expect(posture.policy).toContain('Read-only setup/onboarding posture');
      expect(posture.setupWizard.status).toBe('blocked');
      expect(posture.setupWizard.currentStepId).toBe('connected-host-auth');
      expect(posture.setupWizard.currentStepLabel).toBe('Connected-host auth');
      expect(posture.setupWizard.progressLabel).toContain('setup step');
      expect(posture.setupWizard.next).toContain('Connected-host auth');
      expect(posture.setupWizard._diagnostic.smokeHistory.status).toBe('unavailable');
      expect(posture.setupWizard._diagnostic.smokeHistory.rerunRoute).toContain('setup action:"smoke"');
      expect(posture.setupWizard._diagnostic.smokeHistory.saveRoute).toContain('fields:{...}');
      expect(posture.setupWizard._diagnostic.closeout.status).toBe('blocked');
      expect(posture.setupWizard._diagnostic.closeout.label).toBe('Fix setup blocker');
      expect(posture.setupWizard._diagnostic.closeout.primaryStepId).toBe('connected-host-auth');
      expect(posture.setupWizard._diagnostic.closeout.modelRoute).toContain('setup action:"token"');
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('critical setup blockers: Connected-host auth');
      expect(posture.setupCloseout).toMatchObject({
        status: 'blocked',
        primaryStepId: 'connected-host-auth',
        requiresConfirmation: false,
      });
      expect(posture.setupWizard.steps[0]?.id).toBe('connected-host-readiness');
      expect(posture.setupWizard.steps[0]?.status).toBe('blocked');
      expect(posture.setupWizard.steps[0]?.modelRoute).toContain('host action:"status"');
      expect(posture.setupWizard.steps.find((step) => step.id === 'connected-host-auth')?.status).toBe('current');

      const first = posture.readinessPlan[0];
      expect(first?.setupItemId).toBe('connected-host-readiness');
      expect(first?.status).toBe('check');
      expect(first?.blocksAutonomy).toBe(true);
      expect(first?.modelRoute).toContain('host action:"status"');
      expect(first?.userRoute).toContain('Connected Host');
      expect(first?.primaryHandoff?.id).toBe('connected-host-status');
      expect(first?.primaryHandoff?.kind).toBe('diagnostic');
      expect(first?.primaryHandoff?.modelRoute).toContain('host action:"status"');
      expect(first?.handoffs?.map((handoff) => handoff.id)).toContain('connected-host-bootstrap');
      expect(first?.availableRepairCards).toContain('connected-host-status');
      expect(first?.bootstrapRoute).toContain('connected-host-readiness');
      expect(first?.serviceLifecycleDecision?.status).toBe('needs-status-receipt');
      expect(first?.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(first?.serviceLifecycleDecision?.modelRoute).toContain('services.status');
      expect(first?.serviceLifecycleDecision?.reason).toContain('Probe evidence is not enough');
      expect(first?.serviceLifecycleDecision?.evidence.serviceStatusMethodPublished).toBe(true);
      expect(first?.serviceLifecycleDecision?.receiptRules.join('\n')).toContain('installed:false');
      expect(first?.serviceLifecycleDecision?.blockedMutations.join('\n')).toContain('services.start');
      expect(first?.bootstrapPlan?.source).toContain('goodvibes-tui');
      expect(first?.bootstrapPlan?.steps.map((step) => step.id)).toEqual([
        'verify-bun',
        'install-goodvibes-host',
        'verify-goodvibes-binaries',
        'start-goodvibes-host',
        'reconnect-agent',
      ]);
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'install-goodvibes-host')?.commands.join('\n')).toContain('bun add -g @pellux/goodvibes-tui');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'install-goodvibes-host')?.commands.join('\n')).toContain('bun pm trust -g');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'verify-goodvibes-binaries')?.commands.join('\n')).toContain('goodvibes-daemon --version');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'start-goodvibes-host')?.commands.join('\n')).toContain('goodvibes service start');
      expect(first?.bootstrapPlan?.steps.find((step) => step.id === 'reconnect-agent')?.fallback).toContain('GOODVIBES_AGENT_RUNTIME_URL');
      expect(first?.bootstrapPlan?.reconnectRoutes.agentStatus).toContain('host action:"status"');
      expect(first?.bootstrapPlan?.policy).toContain('does not run host install/start commands implicitly');
      expect(first?.repairCards?.find((card) => card.id === 'service-status')?.methodId).toBe('services.status');
      expect(first?.repairCards?.find((card) => card.id === 'service-install')?.modelRoute).toContain('services.install');
      expect(first?.repairCards?.find((card) => card.id === 'service-start')?.effect).toBe('confirmed-effect');
      expect(first?.repairCards?.find((card) => card.id === 'service-restart')?.safety).toContain('Confirmed service mutation');
      expect(first?.repairCards?.some((card) => card.methodId === 'services.uninstall')).toBe(false);

      expect(posture.readinessPlan
        .filter((item) => item.status === 'blocked' || item.status === 'check' || item.status === 'recommended')
        .every((item) => Boolean(item.primaryHandoff?.modelRoute))).toBe(true);
      const auth = posture.readinessPlan.find((item) => item.setupItemId === 'connected-host-auth');
      expect(auth?.primaryHandoff?.id).toBe('provision-connected-host-token');
      expect(auth?.primaryHandoff?.requiresConfirmation).toBe(true);
      expect(auth?.primaryHandoff?.modelRoute).toContain('setup action:"token"');

      const provider = posture.readinessPlan.find((item) => item.setupItemId === 'provider-access');
      expect(['ready', 'blocked']).toContain(provider!.status);
      expect(provider?.blocksAutonomy).toBe(true);
      expect(provider?.modelRoute).toContain('models action:"status');
      expect(provider?.nextAction).toMatch(/Choose a provider\/model route|Review the current model route/);
      expect(provider?.primaryHandoff?.id).toBe('open-main-model-picker');
      expect(provider?.primaryHandoff?.modelRoute).toContain('surfaceId:"model-picker"');
      expect(provider?.primaryHandoff?.requiresConfirmation).toBe(true);
      expect(posture.nextSetupActions[0]?.setupItemId).toBe('connected-host-readiness');
      expect(posture.nextSetupActions[0]?.handoffRoute).toContain('host action:"status"');
      expect(posture.nextSetupActions.find((item) => item.setupItemId === 'connected-host-auth')?.handoffRoute).toContain('setup action:"token"');

      const installSmoke = posture.readinessPlan.find((item) => item.setupItemId === 'install-smoke');
      expect(installSmoke?.status).toBe('blocked');
      expect(installSmoke?.blocksAutonomy).toBe(false);
      expect(installSmoke?.priority).toBe(22);
      expect(installSmoke?.modelRoute).toContain('install-smoke');
      expect(installSmoke?.primaryHandoff?.id).toBe('run-setup-smoke');
      expect(installSmoke?.primaryHandoff?.modelRoute).toContain('setup action:"smoke"');
      expect(installSmoke?.primaryHandoff?.requiresConfirmation).toBe(true);
      expect(installSmoke?.signals?.join('\n')).toContain('install smoke');
      expect(installSmoke?.installSmokePlan?.source).toContain('GoodVibes Agent installed package');
      expect(installSmoke?.installSmokePlan?.checks.map((check) => check.id)).toEqual([
        'agent-binary',
        'connected-host-status',
        'connected-host-auth',
        'provider-model',
        'setup-posture',
        'first-assistant-turn',
      ]);
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'agent-binary')?.route).toContain('goodvibes-agent --version');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'connected-host-status')?.route).toContain('host action:"status"');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'connected-host-auth')?.route).toContain('connected-host-auth');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'provider-model')?.route).toContain('models action:"status"');
      expect(installSmoke?.installSmokePlan?.checks.find((check) => check.id === 'first-assistant-turn')?.route).toContain('Say ready');
      expect(installSmoke?.installSmokePlan?.successCriteria.join('\n')).toContain('first assistant turn');
      expect(installSmoke?.installSmokePlan?.policy).toContain('does not run package, host, or shell smoke commands implicitly');

      const localModels = posture.readinessPlan.find((item) => item.setupItemId === 'local-model-readiness');
      expect(localModels?.status).toBe('recommended');
      expect(localModels?.blocksAutonomy).toBe(false);
      expect(localModels?.modelRoute).toBe('models action:"local"');
      expect(localModels?.primaryHandoff?.id).toBe('inspect-local-model-cookbook');
      expect(localModels?.primaryHandoff?.modelRoute).toContain('models action:"local"');
      expect(localModels?.signals?.join('\n')).toContain('cookbook status');
      expect(localModels?.signals?.join('\n')).toContain('top recipe');
      expect(localModels?.localModelReadiness?.cookbookStatus).toBe('recommendations-only');
      expect(localModels?.localModelReadiness?.inspectRoute).toContain('models action:"local"');
      expect(localModels?.localModelReadiness?.inspectRecipeRoute).toContain('local-model-cookbook');
      expect(localModels?.localModelReadiness?.topRecipe?.id).toBeTruthy();
      expect(localModels?.localModelReadiness?.topRecipe?.readinessScore).toBeGreaterThan(0);
      expect(localModels?.localModelReadiness?.readinessRubric?.dimensions.map((dimension) => dimension.id)).toEqual([
        'latency',
        'context-window',
        'tool-support',
        'vision',
        'cost',
        'privacy',
      ]);
      expect(localModels?.localModelReadiness?.nextActions?.join('\n')).toContain('Refresh the model catalog');

      const browserControl = posture.readinessPlan.find((item) => item.setupItemId === 'browser-desktop-control');
      expect(browserControl?.status).toBe('recommended');
      expect(browserControl?.blocksAutonomy).toBe(false);
      expect(browserControl?.userRoute).toContain('Tools & MCP');
      expect(browserControl?.modelRoute).toContain('mcp_servers');
      expect(browserControl?.signals?.join('\n')).toContain('No browser');

      const sudoPosture = posture.readinessPlan.find((item) => item.setupItemId === 'sudo-execution-posture');
      expect(['optional', 'check']).toContain(sudoPosture!.status);
      expect(sudoPosture?.blocksAutonomy).toBe(false);
      expect(sudoPosture?.priority).toBe(66);
      expect(sudoPosture?.modelRoute).toContain('sudo-execution-posture');
      expect(sudoPosture?.primaryHandoff?.id).toBe('inspect-sudo-posture');
      expect(sudoPosture?.handoffs?.map((handoff) => handoff.id)).toEqual(expect.arrayContaining([
        'inspect-process-parity',
        'inspect-foreground-shell-route',
        'review-sudo-env-guidance',
      ]));
      expect(sudoPosture?.signals?.join('\n')).toContain('background sudo prompt: blocked');
      expect(sudoPosture?.sudoPosture?.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(sudoPosture?.sudoPosture?.credentialSignal.rawValueReturned).toBe(false);
      expect(sudoPosture?.sudoPosture?.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(sudoPosture?.sudoPosture?.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');
      expect(sudoPosture?.sudoPosture?.missingContracts).toContain('daemon credential-prompt mediation');
      expect(sudoPosture?.sudoPosture?.policy).toContain('never reads');

      const hostItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly modelRoute: string;
        readonly bootstrapPlan?: {
          readonly steps: readonly { readonly id: string; readonly commands: readonly string[] }[];
          readonly policy: string;
        };
        readonly repairCards?: readonly {
          readonly id: string;
          readonly state: string;
          readonly methodId?: string;
          readonly modelRoute?: string;
        }[];
        readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string; readonly modelRoute: string };
        readonly policy?: { readonly effect: string };
      }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });
      expect(hostItem.setupItemId).toBe('connected-host-readiness');
      expect(hostItem.status).toBe('check');
      expect(hostItem.lookup?.resolvedBy).toBe('plan-id');
      expect(hostItem.modelRoute).toContain('host action:"status"');
      expect(hostItem.bootstrapPlan?.steps.find((step) => step.id === 'verify-bun')?.commands).toEqual(['bun --version']);
      expect(hostItem.bootstrapPlan?.policy).toContain('confirmed operator methods');
      expect(hostItem.repairCards?.find((card) => card.id === 'service-start')?.modelRoute).toContain('services.start');
      expect(hostItem.serviceLifecycleDecision?.status).toBe('needs-status-receipt');
      expect(hostItem.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(hostItem.serviceLifecycleDecision?.modelRoute).toContain('services.status');
      expect(hostItem.policy?.effect).toBe('read-only');

      const hostRepair = await executeHarnessJson<{
        readonly mode: string;
        readonly setupItemId: string;
        readonly decision: {
          readonly id: string;
          readonly status: string;
          readonly effect: string;
          readonly modelRoute: string;
          readonly requiresConfirmation?: boolean;
        };
        readonly possibleConfirmedRepairs?: readonly { readonly id: string; readonly requiresConfirmation?: boolean; readonly modelRoute: string }[];
        readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string };
        readonly policy: { readonly effect: string; readonly boundary: string; readonly hostOwnership: string };
      }>(fixture, { mode: 'setup_repair', setupItemId: 'connected-host-readiness', includeParameters: true });
      expect(hostRepair.mode).toBe('setup_repair');
      expect(hostRepair.setupItemId).toBe('connected-host-readiness');
      expect(hostRepair.decision.id).toBe('service-status');
      expect(hostRepair.decision.status).toBe('inspect-first');
      expect(hostRepair.decision.effect).toBe('read-only');
      expect(hostRepair.decision.modelRoute).toContain('services.status');
      expect(hostRepair.decision.requiresConfirmation).toBeUndefined();
      expect(hostRepair.possibleConfirmedRepairs?.map((repair) => repair.id)).toEqual(expect.arrayContaining([
        'service-install',
        'service-start',
        'service-restart',
      ]));
      expect(hostRepair.possibleConfirmedRepairs?.every((repair) => repair.requiresConfirmation === true)).toBe(true);
      expect(hostRepair.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(hostRepair.policy.effect).toBe('read-only-repair-decision');
      expect(hostRepair.policy.boundary).toContain('never starts');
      expect(hostRepair.policy.hostOwnership).toContain('does not take ambient ownership');

      const localModelItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly modelRoute: string;
        readonly localModelReadiness?: {
          readonly topRecipe?: { readonly readinessScore?: number | null };
          readonly readinessRubric?: { readonly dimensions: readonly { readonly id: string }[] };
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'local-model-readiness' });
      expect(localModelItem.setupItemId).toBe('local-model-readiness');
      expect(localModelItem.status).toBe('recommended');
      expect(localModelItem.lookup?.resolvedBy).toBe('plan-id');
      expect(localModelItem.modelRoute).toContain('models action:"local"');
      expect(localModelItem.localModelReadiness?.topRecipe?.readinessScore).toBeGreaterThan(0);
      expect(localModelItem.localModelReadiness?.readinessRubric?.dimensions.map((dimension) => dimension.id)).toContain('privacy');

      const installSmokeItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly installSmokePlan?: {
          readonly status: string;
          readonly checks: readonly { readonly id: string; readonly status: string; readonly route: string }[];
          readonly policy: string;
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'install-smoke' });
      expect(installSmokeItem.setupItemId).toBe('install-smoke');
      expect(installSmokeItem.status).toBe('blocked');
      expect(installSmokeItem.lookup?.resolvedBy).toBe('plan-id');
      expect(installSmokeItem.installSmokePlan?.checks.find((check) => check.id === 'connected-host-auth')?.status).toBe('blocked');
      expect(installSmokeItem.installSmokePlan?.checks.find((check) => check.id === 'first-assistant-turn')?.status).toBe('user-run');
      expect(installSmokeItem.installSmokePlan?.policy).toContain('token-safe');

      const unconfirmedSmoke = await fixture.tool.execute({ mode: 'run_setup_smoke', setupItemId: 'install-smoke' });
      expect(unconfirmedSmoke.success).toBe(false);
      expect(unconfirmedSmoke.error).toContain('explicitUserRequest');

      const smokeMissingConfirm = await fixture.tool.execute({
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        explicitUserRequest: 'Run the install smoke checks',
      });
      expect(smokeMissingConfirm.success).toBe(false);
      expect(smokeMissingConfirm.error).toContain('confirm:true');

      const smokeRun = await executeHarnessJson<{
        readonly status: string;
        readonly mode: string;
        readonly setupItemId: string;
        readonly smokeStatus: string;
        readonly result: string;
        readonly summary: { readonly blocked: number; readonly userRun: number; readonly total: number };
        readonly blockedChecks: readonly string[];
        readonly userRunChecks: readonly string[];
        readonly checks: readonly { readonly id: string; readonly status: string; readonly action: string; readonly route: string; readonly evidence: string }[];
        readonly artifact: { readonly status: string; readonly reason?: string; readonly supportedFields?: readonly string[] };
        readonly nextAction: string;
        readonly routes: { readonly inspectSetup: string; readonly inspectSmoke: string; readonly rerunSmoke: string };
        readonly policy: { readonly effect: string; readonly shell: string; readonly secrets: string; readonly source: string };
      }>(fixture, {
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        includeParameters: true,
        confirm: true,
        explicitUserRequest: 'Run the install smoke checks',
      });
      expect(smokeRun.status).toBe('executed');
      expect(smokeRun.mode).toBe('run_setup_smoke');
      expect(smokeRun.setupItemId).toBe('install-smoke');
      expect(smokeRun.smokeStatus).toBe('blocked');
      expect(smokeRun.result).toBe('blocked');
      expect(smokeRun.summary.total).toBe(6);
      expect(smokeRun.summary.blocked).toBeGreaterThanOrEqual(1);
      expect(smokeRun.summary.userRun).toBeGreaterThanOrEqual(1);
      expect(smokeRun.blockedChecks).toContain('connected-host-auth');
      expect(smokeRun.userRunChecks).toContain('first-assistant-turn');
      expect(smokeRun.checks.map((check) => check.id)).toEqual([
        'agent-binary',
        'connected-host-status',
        'connected-host-auth',
        'provider-model',
        'setup-posture',
        'first-assistant-turn',
      ]);
      expect(smokeRun.checks.find((check) => check.id === 'agent-binary')?.action).toBe('user-visible-run');
      expect(smokeRun.checks.find((check) => check.id === 'connected-host-auth')?.action).toBe('fix-before-smoke');
      expect(smokeRun.artifact.status).toBe('not_requested');
      expect(smokeRun.artifact.supportedFields).toContain('agentBinaryOutput');
      expect(smokeRun.nextAction).toContain('Resolve blocked checks');
      expect(smokeRun.routes.inspectSetup).toContain('setup action:"status"');
      expect(smokeRun.routes.inspectSmoke).toContain('install-smoke');
      expect(smokeRun.routes.rerunSmoke).toContain('setup action:"smoke"');
      expect(smokeRun.policy.effect).toBe('confirmed-redacted-setup-smoke');
      expect(smokeRun.policy.shell).toContain('No package, host, or shell commands were executed implicitly');
      expect(smokeRun.policy.secrets).toContain('tokens are never returned');
      expect(JSON.stringify(smokeRun)).not.toContain('fixture-connected-host-token');

      const browserItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly modelRoute: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(browserItem.setupItemId).toBe('browser-desktop-control');
      expect(browserItem.status).toBe('recommended');
      expect(browserItem.lookup?.resolvedBy).toBe('plan-id');
      expect(browserItem.modelRoute).toContain('mcp_servers');
      expect(browserItem.signals?.join('\n')).toContain('No browser');

      const sudoItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly lookup?: { readonly resolvedBy?: string };
        readonly sudoPosture?: {
          readonly setupRoute: string;
          readonly credentialSignal: {
            readonly checked: string;
            readonly rawValueReturned: boolean;
            readonly valueUsableForBackgroundProcess: boolean;
          };
          readonly supportedRoutes: readonly { readonly id: string; readonly route: string }[];
          readonly blockedRoutes: readonly { readonly id: string; readonly reason: string }[];
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'sudo-execution-posture' });
      expect(sudoItem.setupItemId).toBe('sudo-execution-posture');
      expect(['optional', 'check']).toContain(sudoItem.status);
      expect(sudoItem.lookup?.resolvedBy).toBe('plan-id');
      expect(sudoItem.sudoPosture?.setupRoute).toContain('sudo-execution-posture');
      expect(sudoItem.sudoPosture?.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(sudoItem.sudoPosture?.credentialSignal.rawValueReturned).toBe(false);
      expect(sudoItem.sudoPosture?.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(sudoItem.sudoPosture?.supportedRoutes.map((route) => route.id)).toContain('foreground-supervised-shell');
      expect(sudoItem.sudoPosture?.blockedRoutes.map((route) => route.id)).toContain('raw-password-display');
    } finally {
      fixture.cleanup();
    }
  });

  test('retains durable receipts as history without upgrading live host or auth readiness', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      text: '{}',
      filename: 'setup-service-ready.json',
      mimeType: 'application/json',
      metadata: {
        purpose: 'connected-host-setup-receipt',
        methodId: 'services.status',
        receiptId: 'svc-ready',
        receiptStatus: 'ready',
        recordedAt: '1970-01-01T00:00:03.000Z',
        summary: 'services.status reported healthy.',
      },
    });
    await artifacts.store.create({
      text: '{}',
      filename: 'setup-auth-ready.json',
      mimeType: 'application/json',
      metadata: {
        purpose: 'connected-host-setup-receipt',
        setupStepId: 'connected-host-auth',
        receiptId: 'auth-ready',
        receiptStatus: 'authenticated',
        recordedAt: '1970-01-01T00:00:04.000Z',
        summary: 'Connected-host operator auth was validated.',
      },
    });
    await artifacts.store.create({
      text: '{}',
      filename: 'setup-smoke-ready.json',
      mimeType: 'application/json',
      metadata: {
        purpose: 'agent-setup-receipt',
        setupStepId: 'install-smoke',
        receiptId: 'smoke-ready',
        receiptStatus: 'ready',
        recordedAt: '1970-01-01T00:00:05.000Z',
        summary: 'Setup smoke completed with first assistant turn.',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const posture = await executeHarnessJson<{
        readonly setupWizard: {
          readonly steps: readonly { readonly id: string; readonly status: string; readonly detail: string }[];
          readonly _diagnostic: {
            readonly stepHistory: readonly {
              readonly kind: string;
              readonly receiptId: string;
              readonly receiptStatus?: string;
              readonly satisfiesReceipt?: boolean;
            }[];
            readonly receiptGaps: readonly { readonly stepId: string }[];
            readonly closeout: {
              readonly evidence: readonly string[];
            };
          };
        };
      }>(fixture, { mode: 'setup_posture', includeParameters: true });

      const steps = new Map(posture.setupWizard.steps.map((step) => [step.id, step]));
      expect(steps.get('connected-host-readiness')?.status).toBe('blocked');
      expect(steps.get('connected-host-readiness')?.detail).not.toContain('Durable receipt svc-ready');
      expect(steps.get('connected-host-auth')?.status).toBe('current');
      expect(steps.get('install-smoke')?.status).toBe('done');
      expect(posture.setupWizard._diagnostic.stepHistory.filter((entry) => entry.kind === 'durable-receipt')).toHaveLength(3);
      expect(posture.setupWizard._diagnostic.stepHistory.every((entry) => entry.satisfiesReceipt === true)).toBe(true);
      expect(posture.setupWizard._diagnostic.receiptGaps).toEqual([]);
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('setup smoke receipt: ready');
    } finally {
      fixture.cleanup();
    }
  });

  test('retains read-model receipts without upgrading live host or auth readiness', async () => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.setup = {
        getSnapshot: () => ({
          setupReceipts: {
            service: {
              methodId: 'services.status',
              receiptId: 'live-svc-ready',
              receiptStatus: 'ready',
              recordedAt: '1970-01-01T00:00:03.000Z',
              summary: 'services.status reported healthy from live daemon setup receipts.',
            },
            auth: {
              setupStepId: 'connected-host-auth',
              receiptId: 'live-auth-ready',
              status: 'authenticated',
              recordedAt: '1970-01-01T00:00:04.000Z',
              summary: 'Connected-host operator auth token=hidden-live-secret was validated.',
              inspectRoute: 'setup action:"item" setupItemId:"connected-host-auth" includeParameters:true',
            },
            smoke: {
              setupStepId: 'install-smoke',
              receiptId: 'live-smoke-ready',
              outcome: 'ready',
              recordedAt: '1970-01-01T00:00:05.000Z',
              summary: 'Setup smoke completed through live setup receipt stream.',
            },
          },
        }),
      };
      readModels.setupReceiptEventStream = {
        listEvents: () => ({
          cursor: 'setup-cursor-0006',
          events: [{
            setupStepId: 'install-smoke',
            receiptId: 'live-smoke-event-ready',
            receiptStatus: 'ready',
            recordedAt: '1970-01-01T00:00:06.000Z',
            summary: 'Setup smoke event stream certified first-run output with token=event-stream-secret.',
            schemaVersion: 'goodvibes.setup.receipt.v1',
            schemaStatus: 'certified',
            methodId: 'setup.smoke',
            repairRoute: 'setup action:"smoke" setupItemId:"install-smoke" confirm:true explicitUserRequest:"..."',
            actionRoute: 'setup action:"finish" confirm:true explicitUserRequest:"..."',
            publicationGuarantee: 'The GoodVibes daemon publishes ordered setup receipt events before closeout; token=publication-secret.',
            publisher: 'goodvibes-daemon',
            eventSequence: 6,
            inspectRoute: 'setup action:"item" setupItemId:"install-smoke" includeParameters:true',
          }],
        }),
      };

      const posture = await executeHarnessJson<{
        readonly setupWizard: {
          readonly steps: readonly { readonly id: string; readonly status: string; readonly detail: string }[];
          readonly _diagnostic: {
            readonly stepHistory: readonly {
              readonly kind: string;
              readonly receiptId: string;
              readonly source?: string;
              readonly summary: string;
              readonly receiptStatus?: string;
              readonly satisfiesReceipt?: boolean;
              readonly schemaStatus?: string;
              readonly schemaVersion?: string;
              readonly provenance?: readonly string[];
              readonly publicationGuarantee?: string;
              readonly eventCursor?: string;
              readonly eventSequence?: number;
              readonly publisher?: string;
            }[];
            readonly receiptGaps: readonly { readonly stepId: string }[];
            readonly closeout: {
              readonly evidence: readonly string[];
            };
          };
        };
      }>(fixture, { mode: 'setup_posture', includeParameters: true });

      const steps = new Map(posture.setupWizard.steps.map((step) => [step.id, step]));
      expect(steps.get('connected-host-readiness')?.status).toBe('blocked');
      expect(steps.get('connected-host-readiness')?.detail).not.toContain('live-svc-ready');
      expect(steps.get('connected-host-auth')?.status).toBe('current');
      expect(steps.get('connected-host-auth')?.detail).not.toContain('hidden-live-secret');
      expect(steps.get('install-smoke')?.status).toBe('done');
      const durableHistory = posture.setupWizard._diagnostic.stepHistory.filter((entry: { kind: string; receiptId: string }) => entry.kind === 'durable-receipt');
      expect(durableHistory).toHaveLength(4);
      expect(durableHistory.filter((entry: { receiptId: string; source?: string }) => entry.receiptId !== 'live-smoke-event-ready').every((entry: { source?: string }) => entry.source === 'context.platform.readModels.setup')).toBe(true);
      expect(durableHistory.find((entry: { receiptId: string; summary: string }) => entry.receiptId === 'live-auth-ready')?.summary).toContain('token=<redacted>');
      const eventReceipt = durableHistory.find((entry: { receiptId: string }) => entry.receiptId === 'live-smoke-event-ready');
      expect(eventReceipt?.source).toBe('context.platform.readModels.setupReceiptEventStream');
      expect(eventReceipt?.schemaStatus).toBe('certified');
      expect(eventReceipt?.schemaVersion).toBe('goodvibes.setup.receipt.v1');
      expect(eventReceipt?.eventCursor).toBe('setup-cursor-0006');
      expect(eventReceipt?.eventSequence).toBe(6);
      expect(eventReceipt?.publisher).toBe('goodvibes-daemon');
      expect(eventReceipt?.summary).toContain('token=<redacted>');
      expect(eventReceipt?.summary).not.toContain('event-stream-secret');
      expect(eventReceipt?.publicationGuarantee).toContain('token=<redacted>');
      expect(eventReceipt?.publicationGuarantee).not.toContain('publication-secret');
      expect(eventReceipt?.provenance?.join('\n')).toContain('method setup.smoke');
      expect(eventReceipt?.provenance?.join('\n')).toContain('repair setup action:"smoke"');
      expect(durableHistory.every((entry: { satisfiesReceipt?: boolean }) => entry.satisfiesReceipt === true)).toBe(true);
      expect(posture.setupWizard._diagnostic.receiptGaps).toEqual([]);
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('setup smoke receipt: ready');
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('certified setup receipts: 1/4');
      expect(posture.setupWizard._diagnostic.closeout.evidence.join('\n')).toContain('setup receipt event streams: 1');
    } finally {
      fixture.cleanup();
    }
  });

  test('persists setup wizard checkpoints through confirmed harness and workspace routes', async () => {
    const fixture = makeFixture();
    try {
      const initial = await executeHarnessJson<{
        readonly checkpoint: { readonly status: string; readonly path: string | null; readonly resumed: boolean };
        readonly setupWizard: { readonly currentStepId: string | null; readonly currentStepLabel: string | null };
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(initial.checkpoint.status).toBe('none');
      expect(initial.checkpoint.path).toContain('wizard-checkpoint.json');
      expect(initial.setupWizard.currentStepId).toBe('connected-host-auth');

      const unconfirmed = await fixture.tool.execute({
        mode: 'mark_setup_checkpoint',
        explicitUserRequest: 'Save setup resume point.',
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('confirm:true');

      const saved = await executeHarnessJson<{
        readonly status: string;
        readonly step: { readonly id: string; readonly label: string; readonly sourceStatus: string };
        readonly checkpoint: { readonly exists: boolean; readonly checkpoint?: { readonly currentStepId: string; readonly currentStepLabel: string; readonly source: string } | null };
        readonly setupWizard: {
          readonly currentStepId: string | null;
          readonly checkpoint: { readonly status: string; readonly resumed: boolean; readonly summary: string };
        };
      }>(fixture, {
        mode: 'mark_setup_checkpoint',
        confirm: true,
        explicitUserRequest: 'Save setup resume point.',
      });
      expect(saved.status).toBe('checkpoint_saved');
      expect(saved.step).toMatchObject({ id: 'connected-host-auth', label: 'Connected-host auth', sourceStatus: 'blocked' });
      expect(saved.checkpoint.exists).toBe(true);
      expect(saved.checkpoint.checkpoint).toMatchObject({
        currentStepId: 'connected-host-auth',
        currentStepLabel: 'Connected-host auth',
        source: 'harness',
      });
      expect(saved.setupWizard.currentStepId).toBe('connected-host-auth');
      expect(saved.setupWizard.checkpoint).toMatchObject({
        status: 'available',
        resumed: true,
      });

      const inspected = await executeHarnessJson<{
        readonly checkpoint: { readonly status: string; readonly currentStepId: string; readonly resumed: boolean; readonly summary: string };
        readonly currentStep: { readonly id: string; readonly status: string } | null;
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(inspected.checkpoint.status).toBe('available');
      expect(inspected.checkpoint.currentStepId).toBe('connected-host-auth');
      expect(inspected.checkpoint.resumed).toBe(true);
      expect(inspected.checkpoint.summary).toContain('Resuming Connected-host auth');
      expect(inspected.currentStep?.id).toBe('connected-host-auth');

      writeConnectedHostOperatorToken(fixture);
      const advanced = await executeHarnessJson<{
        readonly checkpoint: {
          readonly status: string;
          readonly currentStepId: string;
          readonly resumed: boolean;
          readonly summary: string;
          readonly autoAdvance?: {
            readonly status: string;
            readonly fromStepId: string | null;
            readonly fromStepLabel: string | null;
            readonly toStepId: string | null;
            readonly toStepLabel: string | null;
            readonly reason: string;
            readonly evidence: string;
            readonly clearRoute: string;
          };
        };
        readonly currentStep: { readonly id: string; readonly status: string } | null;
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(advanced.checkpoint.status).toBe('available');
      expect(advanced.checkpoint.resumed).toBe(true);
      expect(advanced.checkpoint.summary).toContain('Resuming Connected-host auth');
      expect(advanced.checkpoint.autoAdvance?.status).not.toBe('advanced');
      expect(advanced.currentStep?.id).toBe('connected-host-auth');

      const workspaceSaved = await executeHarnessJson<{
        readonly status: string;
        readonly result: {
          readonly status: string;
          readonly setupWizard: { readonly checkpoint: { readonly status: string; readonly resumed: boolean } };
        };
      }>(fixture, {
        mode: 'run_workspace_action',
        actionId: 'setup-checkpoint-mark-current',
        confirm: true,
        explicitUserRequest: 'Keep my setup wizard place.',
      });
      expect(workspaceSaved.status).toBe('checkpoint_action_completed');
      expect(workspaceSaved.result.status).toBe('checkpoint_saved');
      expect(workspaceSaved.result.setupWizard.checkpoint).toMatchObject({
        status: 'available',
        resumed: true,
      });

      const cleared = await executeHarnessJson<{
        readonly status: string;
        readonly checkpoint: { readonly exists: boolean; readonly checkpoint: null };
      }>(fixture, {
        mode: 'clear_setup_checkpoint',
        confirm: true,
        explicitUserRequest: 'Clear setup resume point.',
      });
      expect(cleared.status).toBe('checkpoint_cleared');
      expect(cleared.checkpoint.exists).toBe(false);
      expect(cleared.checkpoint.checkpoint).toBeNull();

      const afterClear = await executeHarnessJson<{
        readonly checkpoint: { readonly status: string; readonly resumed: boolean };
      }>(fixture, { mode: 'setup_checkpoint' });
      expect(afterClear.checkpoint.status).toBe('none');
      expect(afterClear.checkpoint.resumed).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces VIBE.md personality health in setup and learning curator', async () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.root, 'VIBE.md'), '# Project VIBE\n\napi_key=supersecretvalue\n');
      const globalVibePath = fixture.paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'VIBE.md');
      mkdirSync(join(fixture.root, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT), { recursive: true });
      writeFileSync(globalVibePath, `# Global VIBE\n\n${'Prefer calm direct answers. '.repeat(420)}\n`);

      const posture = await executeHarnessJson<{
        readonly readinessPlan: readonly {
          readonly setupItemId: string;
          readonly status: string;
          readonly priority: number;
          readonly signals?: readonly string[];
          readonly primaryHandoff?: { readonly id: string; readonly modelRoute: string };
          readonly handoffs?: readonly { readonly id: string; readonly requiresConfirmation?: boolean }[];
          readonly vibeHealth?: {
            readonly applied: number;
            readonly blocked: number;
            readonly truncated: number;
            readonly files: readonly { readonly path: string; readonly truncated?: boolean }[];
            readonly blockedFiles: readonly { readonly path: string; readonly reason: string }[];
          };
        }[];
      }>(fixture, { mode: 'setup_posture', includeParameters: true });
      const vibeItem = posture.readinessPlan.find((item) => item.setupItemId === 'vibe-personality');
      expect(vibeItem?.status).toBe('check');
      expect(vibeItem?.priority).toBe(35);
      expect(vibeItem?.signals?.join('\n')).toContain('blocked VIBE.md files: 1');
      expect(vibeItem?.signals?.join('\n')).toContain('truncated VIBE.md files: 1');
      expect(vibeItem?.primaryHandoff?.id).toBe('inspect-vibe-status');
      expect(vibeItem?.primaryHandoff?.modelRoute).toBe('vibe action:"status"');
      expect(vibeItem?.handoffs?.some((handoff) => handoff.id === 'init-project-vibe' && handoff.requiresConfirmation)).toBe(true);
      expect(vibeItem?.handoffs?.some((handoff) => handoff.id === 'import-vibe-persona' && handoff.requiresConfirmation)).toBe(true);
      expect(vibeItem?.vibeHealth?.applied).toBe(1);
      expect(vibeItem?.vibeHealth?.blocked).toBe(1);
      expect(vibeItem?.vibeHealth?.truncated).toBe(1);
      expect(vibeItem?.vibeHealth?.files[0]?.path).toBe(globalVibePath);
      expect(vibeItem?.vibeHealth?.files[0]?.truncated).toBe(true);
      expect(vibeItem?.vibeHealth?.blockedFiles[0]?.path).toBe(join(fixture.root, 'VIBE.md'));
      expect(vibeItem?.vibeHealth?.blockedFiles[0]?.reason).toContain('secret-looking');

      const summary = await executeHarnessJson<{
        readonly learningCurator?: { readonly personalityIssues: number; readonly needsReview: number; readonly needsSetup: number };
      }>(fixture, { mode: 'summary' });
      expect(summary.learningCurator?.personalityIssues).toBe(2);
      expect(summary.learningCurator?.needsReview).toBeGreaterThan(0);
      expect(summary.learningCurator?.needsSetup).toBeGreaterThan(0);

      const curator = await executeHarnessJson<{
        readonly summary: { readonly personalityIssues: number };
        readonly candidates: readonly {
          readonly candidateId: string;
          readonly domain: string;
          readonly status: string;
          readonly recordId: string;
          readonly proposalFields?: Record<string, string>;
          readonly inspectRoute: string;
          readonly reviewRoute?: string;
          readonly createRoute?: string;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'learning_curator', query: 'vibe', includeParameters: true });
      expect(curator.summary.personalityIssues).toBe(2);
      expect(curator.policy).toContain('VIBE.md personality health');
      expectRowsHaveCompactModelRoutes(curator.candidates);
      const blocked = curator.candidates.find((candidate) => candidate.status === 'needs-setup');
      const truncated = curator.candidates.find((candidate) => candidate.status === 'needs-review');
      expect(blocked?.domain).toBe('vibe');
      expect(blocked?.recordId).toBe(join(fixture.root, 'VIBE.md'));
      expect(blocked?.proposalFields?.reason).toContain('secret-looking');
      expect(blocked?.inspectRoute).toBe('vibe action:"status"');
      expect(blocked?.reviewRoute).toBe('vibe action:"status"');
      expect(blocked?.createRoute).toContain('vibe action:"init"');
      expect(truncated?.domain).toBe('vibe');
      expect(truncated?.recordId).toBe(globalVibePath);

      const detail = await executeHarnessJson<{
        readonly candidateId: string;
        readonly domain: string;
        readonly routes?: { readonly inspect: string; readonly review: string | null; readonly create: string | null };
      }>(fixture, { mode: 'learning_candidate', candidateId: blocked?.candidateId });
      expect(detail.domain).toBe('vibe');
      expect(detail.routes?.inspect).toBe('vibe action:"status"');
      expect(detail.routes?.review).toBe('vibe action:"status"');
      expect(detail.routes?.create).toContain('vibe action:"init"');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes project context files to the model without loading blocked content', async () => {
    const fixture = makeFixture();
    try {
      mkdirSync(join(fixture.root, 'frontend', 'src'), { recursive: true });
      mkdirSync(join(fixture.root, '.cursor', 'rules'), { recursive: true });
      writeFileSync(join(fixture.root, 'AGENTS.md'), 'Prefer visible project context before hidden assumptions.');
      writeFileSync(join(fixture.root, 'frontend', 'AGENTS.md'), 'Frontend work should use compact controls and visible state.');
      writeFileSync(join(fixture.root, '.cursor', 'rules', 'ui.mdc'), 'Use focused UI rules for dense operator surfaces.');
      writeFileSync(join(fixture.root, 'CLAUDE.md'), 'api_key=supersecretvalue\nDo not load this project secret.');

      const summary = await executeHarnessJson<{
        readonly projectContext?: {
          readonly status: string;
          readonly loaded: number;
          readonly blocked: number;
          readonly targetAware: boolean;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.projectContext?.status).toBe('attention');
      expect(summary.projectContext?.loaded).toBeGreaterThanOrEqual(1);
      expect(summary.projectContext?.blocked).toBe(1);
      expect(summary.projectContext?.targetAware).toBe(true);

      const catalog = await executeHarnessJson<{
        readonly status: string;
        readonly returned: number;
        readonly total: number;
        readonly loaded: number;
        readonly blocked: number;
        readonly files: readonly {
          readonly id: string;
          readonly path: string;
          readonly source: string;
          readonly scope: string;
          readonly status: string;
          readonly body?: string;
          readonly reason?: string;
          readonly modelRoute: string;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'project_context', target: 'frontend/src/App.ts', includeParameters: true });
      expect(catalog.status).toBe('attention');
      expect(catalog.loaded).toBeGreaterThanOrEqual(3);
      expect(catalog.blocked).toBe(1);
      expect(catalog.returned).toBe(catalog.total);
      expect(catalog.policy).toContain('Secret-looking files are blocked');
      expect(JSON.stringify(catalog)).not.toContain('Do not load this project secret');
      expect(catalog.files.map((file) => file.source)).toEqual(expect.arrayContaining(['AGENTS.md', '.cursor/rules/*.mdc', 'CLAUDE.md']));
      expectRowsHaveCompactModelRoutes(catalog.files);

      const frontendContext = catalog.files.find((file) => file.path.endsWith(join('frontend', 'AGENTS.md')));
      expect(frontendContext?.scope).toBe('subdirectory');
      expect(frontendContext?.modelRoute).toContain('context action:"file"');

      const detail = await executeHarnessJson<{
        readonly path: string;
        readonly status: string;
        readonly body: string;
      }>(fixture, { mode: 'project_context_file', contextFileId: frontendContext?.id, target: 'frontend/src/App.ts' });
      expect(detail.path).toBe(frontendContext!.path);
      expect(detail.status).toBe('loaded');
      expect(detail.body).toContain('compact controls');

      const blocked = catalog.files.find((file) => file.status === 'blocked');
      const blockedDetail = await executeHarnessJson<{
        readonly status: string;
        readonly reason: string;
      }>(fixture, { mode: 'project_context_file', contextFileId: blocked?.id });
      expect(blockedDetail.status).toBe('blocked');
      expect(blockedDetail.reason).toContain('secret-looking');
      expect(JSON.stringify(blockedDetail)).not.toContain('Do not load this project secret');

      const cursorOnly = await executeHarnessJson<{
        readonly returned: number;
        readonly total: number;
        readonly files: readonly { readonly source: string }[];
      }>(fixture, { mode: 'project_context', query: 'cursor' });
      expect(cursorOnly.returned).toBe(1);
      expect(cursorOnly.total).toBeGreaterThan(cursorOnly.returned);
      expect(cursorOnly.files[0]?.source).toBe('.cursor/rules/*.mdc');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes current prompt context composition and budget without mutating records', async () => {
    const fixture = makeFixture();
    try {
      attachMemoryApi(fixture, [
        makeMemoryRecord(),
        makeMemoryRecord({ id: 'mem-low-confidence', confidence: 55, summary: 'Low confidence memory' }),
        makeMemoryRecord({ id: 'mem-unreviewed', reviewState: 'fresh', confidence: 91, summary: 'Unreviewed memory' }),
      ]);
      writeFileSync(join(fixture.root, 'VIBE.md'), 'Keep the assistant concise and user-first.');
      writeFileSync(join(fixture.root, 'AGENTS.md'), 'Prefer visible prompt context inspection before relying on hidden assumptions.');

      const personaRegistry = AgentPersonaRegistry.fromShellPaths(fixture.paths);
      const persona = personaRegistry.create({
        name: 'Reviewed prompt inspector',
        description: 'Reviewed prompt behavior.',
        body: 'Explain applied context before acting when context is ambiguous.',
        source: 'agent',
      });
      personaRegistry.markReviewed(persona.id);
      personaRegistry.setActive(persona.id);

      const skillRegistry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      const readySkill = skillRegistry.create({
        name: 'Prompt evidence skill',
        description: 'Summarize active prompt evidence.',
        procedure: 'List selected context records, then ask for confirmation before changes.',
        enabled: true,
        source: 'agent',
      });
      skillRegistry.markReviewed(readySkill.id);
      skillRegistry.create({
        name: 'Blocked prompt skill',
        description: 'Needs unavailable setup.',
        procedure: 'Use an unavailable command.',
        requirements: [{ kind: 'command', name: 'definitely-missing-goodvibes-agent-test-command' }],
        enabled: true,
        source: 'agent',
      });

      const routineRegistry = AgentRoutineRegistry.fromShellPaths(fixture.paths);
      const readyRoutine = routineRegistry.create({
        name: 'Prompt closeout routine',
        description: 'Close out prompt context reviews.',
        steps: 'Summarize applied context, suppressed context, and next review route.',
        enabled: true,
        source: 'agent',
      });
      routineRegistry.markReviewed(readyRoutine.id);
      routineRegistry.create({
        name: 'Blocked prompt routine',
        description: 'Needs unavailable setup.',
        steps: 'Run unavailable setup before use.',
        requirements: [{ kind: 'command', name: 'definitely-missing-goodvibes-agent-test-command' }],
        enabled: true,
        source: 'agent',
      });

      const promptContextReceipts = new AgentPromptContextReceiptStore();
      const completedReceipt = promptContextReceipts.record({
        sessionId: 'session-alpha',
        turnId: 'turn-prompt-context-ok',
        source: 'turn',
        provider: 'openai',
        model: 'gpt-4.1',
        contextWindow: 128_000,
        promptHash: 'a'.repeat(64),
        promptChars: 1024,
        approxPromptTokens: 256,
        activeRecords: 3,
        suppressedRecords: 0,
        segments: [{
          id: 'vibe',
          label: 'VIBE.md personality',
          order: 2,
          status: 'active',
          activeCount: 1,
          suppressedCount: 0,
          promptChars: 256,
          approxTokens: 64,
        }],
      });
      promptContextReceipts.recordTurnOutcome({
        turnId: 'turn-prompt-context-ok',
        status: 'completed',
        terminalEvent: 'TURN_COMPLETED',
        stopReason: 'stop',
        completedAt: 1_699_999_999_000,
      });
      const storedReceipt = promptContextReceipts.record({
        sessionId: 'session-alpha',
        turnId: 'turn-prompt-context',
        source: 'turn',
        provider: 'openai',
        model: 'gpt-4.1',
        contextWindow: 128_000,
        promptHash: 'b'.repeat(64),
        promptChars: 2048,
        approxPromptTokens: 512,
        activeRecords: 7,
        suppressedRecords: 2,
        segments: [{
          id: 'memory',
          label: 'Reviewed memory',
          order: 5,
          status: 'attention',
          activeCount: 1,
          suppressedCount: 2,
          promptChars: 512,
          approxTokens: 128,
        }],
      });
      promptContextReceipts.recordTurnOutcome({
        turnId: 'turn-prompt-context',
        status: 'error',
        terminalEvent: 'TURN_ERROR',
        stopReason: 'provider_error',
        detail: 'Provider rejected a test request.',
        completedAt: 1_700_000_000_000,
      });
      (fixture.context.clients as Record<string, unknown>).promptContextReceipts = promptContextReceipts;

      const summary = await executeHarnessJson<{
        readonly promptContext?: {
          readonly status: string;
          readonly activeRecords: number;
          readonly suppressedRecords: number;
          readonly approxPromptTokens: number;
          readonly latestReceiptId?: string | null;
          readonly receiptCount?: number;
          readonly modelRoute: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.promptContext?.status).toBe('attention');
      expect(summary.promptContext?.activeRecords).toBeGreaterThan(4);
      expect(summary.promptContext?.suppressedRecords).toBeGreaterThan(1);
      expect(summary.promptContext?.approxPromptTokens).toBeGreaterThan(0);
      expect(summary.promptContext?.receiptCount).toBe(2);
      expect(summary.promptContext?.latestReceiptId).toBe(storedReceipt.receiptId);
      expect(summary.promptContext?.modelRoute).toContain('context action:"prompt"');

      const promptContext = await executeHarnessJson<{
        readonly status: string;
        readonly order: readonly string[];
        readonly activeRecords: number;
        readonly suppressedRecords: number;
        readonly approxPromptTokens: number;
        readonly budget: { readonly approxPromptTokens: number; readonly percentOfWindow: number | null };
        readonly receipts: {
          readonly status: string;
          readonly count: number;
          readonly latestReceiptId: string | null;
          readonly latestTurnId: string | null;
          readonly matchingCount?: number;
          readonly selected?: { readonly receiptId: string; readonly turnOutcome?: { readonly status: string } } | null;
          readonly routes?: {
            readonly latestReceipt?: string | null;
            readonly filterCompleted?: string;
            readonly filterErrors?: string;
          };
          readonly latest?: {
            readonly receiptId: string;
            readonly turnOutcome?: {
              readonly status: string;
              readonly terminalEvent: string;
              readonly stopReason: string;
              readonly detail?: string;
            };
            readonly promptHash?: string;
            readonly segments?: readonly { readonly id: string; readonly status: string }[];
          } | null;
        };
        readonly segments: readonly {
          readonly id: string;
          readonly status: string;
          readonly activeCount: number;
          readonly suppressedCount: number;
          readonly approxTokens: number;
          readonly selected?: readonly { readonly id?: string; readonly path?: string; readonly name?: string; readonly source?: string; readonly inspectRoute?: string }[];
          readonly suppressed?: readonly { readonly id?: string; readonly reason?: string; readonly reviewState?: string; readonly missingRequirements?: number }[];
          readonly preview?: string;
        }[];
        readonly routes: { readonly promptPlan: string; readonly memoryPosture: string; readonly learningCurator: string };
        readonly policy: string;
      }>(fixture, { mode: 'prompt_context', includeParameters: true });

      expect(promptContext.status).toBe('attention');
      expect(promptContext.order).toEqual(expect.arrayContaining(['vibe', 'project_context', 'memory', 'routines', 'skills', 'persona']));
      expect(promptContext.activeRecords).toBe(summary.promptContext!.activeRecords);
      expect(promptContext.suppressedRecords).toBe(summary.promptContext!.suppressedRecords);
      expect(promptContext.approxPromptTokens).toBe(promptContext.budget.approxPromptTokens);
      expect(promptContext.budget.percentOfWindow).not.toBeNull();
      expect(promptContext.receipts.status).toBe('ready');
      expect(promptContext.receipts.count).toBe(2);
      expect(promptContext.receipts.matchingCount).toBe(2);
      expect(promptContext.receipts.latestReceiptId).toBe(storedReceipt.receiptId);
      expect(promptContext.receipts.latestTurnId).toBe('turn-prompt-context');
      expect(promptContext.receipts.selected).toBeNull();
      expect(promptContext.receipts.routes?.latestReceipt).toContain(`receiptId:"${storedReceipt.receiptId}"`);
      expect(promptContext.receipts.routes?.filterErrors).toContain('outcomeStatus:"error"');
      expect(promptContext.receipts.latest?.turnOutcome?.status).toBe('error');
      expect(promptContext.receipts.latest?.turnOutcome?.terminalEvent).toBe('TURN_ERROR');
      expect(promptContext.receipts.latest?.turnOutcome?.detail).toContain('Provider rejected');
      expect(promptContext.receipts.latest?.promptHash).toBe('b'.repeat(64));
      expect(promptContext.receipts.latest?.segments?.some((segment) => segment.id === 'memory' && segment.status === 'attention')).toBe(true);

      const memory = promptContext.segments.find((segment) => segment.id === 'memory');
      expect(memory?.selected?.some((record) => record.id === 'mem-briefing')).toBe(true);
      expect(memory?.suppressed?.some((record) => record.id === 'mem-low-confidence' && record.reason?.includes('confidence'))).toBe(true);
      // mem-unreviewed (confidence 91) is now ACTIVE: autonomous-learning change dropped the reviewState gate.
      expect(memory?.selected?.some((record) => record.id === 'mem-unreviewed')).toBe(true);
      expect(memory?.preview).toContain('Reviewed GoodVibes Agent Memory');
      // F7c: the memory segment states its own ordering basis so it never reads
      // as contradicting the separately-ranked context action:"receipt" surface.
      expect((memory as unknown as { readonly note?: string })?.note).toContain('confidence/recency');
      expect((memory as unknown as { readonly note?: string })?.note).toContain('not by relevance to the current turn');

      const vibe = promptContext.segments.find((segment) => segment.id === 'vibe');
      expect(vibe?.selected?.[0]?.path).toBe(join(fixture.root, 'VIBE.md'));
      const project = promptContext.segments.find((segment) => segment.id === 'project_context');
      expect(project?.selected?.some((record) => record.source === 'AGENTS.md')).toBe(true);
      const skills = promptContext.segments.find((segment) => segment.id === 'skills');
      expect(skills?.selected?.some((record) => record.id === readySkill.id)).toBe(true);
      expect(skills?.suppressedCount).toBeGreaterThan(0);
      const routines = promptContext.segments.find((segment) => segment.id === 'routines');
      expect(routines?.selected?.some((record) => record.id === readyRoutine.id)).toBe(true);
      expect(routines?.suppressed?.some((record) => record.missingRequirements !== undefined || record.reviewState === 'fresh')).toBe(true);
      const personaSegment = promptContext.segments.find((segment) => segment.id === 'persona');
      expect(personaSegment?.selected?.[0]?.name).toBe('Reviewed prompt inspector');

      expect(promptContext.routes.promptPlan).toContain('memory action:"curator"');
      expect(promptContext.routes.memoryPosture).toContain('memory action:"status"');
      expect(promptContext.routes.learningCurator).toContain('memory action:"curator"');
      expect(promptContext.policy).toContain('Read-only');

      const completedFilter = await executeHarnessJson<{
        readonly receipts: {
          readonly status: string;
          readonly matchingCount: number;
          readonly selected: {
            readonly receiptId: string;
            readonly turnId: string | null;
            readonly turnOutcome?: { readonly status: string; readonly terminalEvent: string };
            readonly promptHash?: string;
          } | null;
          readonly recent: readonly { readonly receiptId: string; readonly turnOutcome?: { readonly status: string } }[];
        };
      }>(fixture, { mode: 'prompt_context', outcomeStatus: 'completed', includeParameters: true });
      expect(completedFilter.receipts.status).toBe('ready');
      expect(completedFilter.receipts.matchingCount).toBe(1);
      expect(completedFilter.receipts.selected?.receiptId).toBe(completedReceipt.receiptId);
      expect(completedFilter.receipts.selected?.turnId).toBe('turn-prompt-context-ok');
      expect(completedFilter.receipts.selected?.turnOutcome?.terminalEvent).toBe('TURN_COMPLETED');
      expect(completedFilter.receipts.selected?.promptHash).toBe('a'.repeat(64));
      expect(completedFilter.receipts.recent.map((receipt) => receipt.receiptId)).toEqual([completedReceipt.receiptId]);

      const exactReceipt = await executeHarnessJson<{
        readonly receipts: {
          readonly status: string;
          readonly matchingCount: number;
          readonly selected: { readonly receiptId: string; readonly turnOutcome?: { readonly status: string } } | null;
          readonly filters?: { readonly receiptId?: string; readonly limit: number };
        };
      }>(fixture, { mode: 'prompt_context', receiptId: storedReceipt.receiptId, limit: 1 });
      expect(exactReceipt.receipts.status).toBe('ready');
      expect(exactReceipt.receipts.matchingCount).toBe(1);
      expect(exactReceipt.receipts.selected?.receiptId).toBe(storedReceipt.receiptId);
      expect(exactReceipt.receipts.selected?.turnOutcome?.status).toBe('error');
      expect(exactReceipt.receipts.filters?.receiptId).toBe(storedReceipt.receiptId);

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'context-prompt-context' });
      expect(action.id).toBe('context-prompt-context');
      expect(action.modelRoute).toBe('context action:"prompt" includeParameters:true');
    } finally {
      fixture.cleanup();
    }
  });

  test('prompt context memory suppressed reasons come straight from describeMemoryPromptEligibility: no "not reviewed"/"outside prompt limit" paraphrase', async () => {
    const fixture = makeFixture();
    try {
      // 11 eligible records (confidence 100 down to 90, all reviewed) so the top-10
      // prompt slice cuts exactly one, that one must read as "eligible ... but outside
      // the top-10 prompt slice ... budget-limited, not a trust problem", never the old
      // coarse "outside prompt limit". A genuinely low-confidence record must still read
      // as ineligible via describeMemoryPromptEligibility's own reason, never "not
      // reviewed" (its reviewState here IS reviewed, confidence is why it fails).
      const eligibleRecords = Array.from({ length: 11 }, (_, index) => makeMemoryRecord({
        id: `mem-eligible-${index}`,
        confidence: 100 - index,
        reviewState: 'reviewed',
        summary: `Eligible memory record ${index}`,
      }));
      const ineligibleRecord = makeMemoryRecord({
        id: 'mem-below-floor',
        confidence: 40,
        reviewState: 'reviewed',
        summary: 'Explicitly below the recall floor',
      });
      attachMemoryApi(fixture, [...eligibleRecords, ineligibleRecord]);

      const promptContext = await executeHarnessJson<{
        readonly segments: readonly {
          readonly id: string;
          readonly selected?: readonly { readonly id?: string }[];
          readonly suppressed?: readonly { readonly id?: string; readonly reason?: string }[];
        }[];
      }>(fixture, { mode: 'prompt_context', includeParameters: true });

      const memory = promptContext.segments.find((segment) => segment.id === 'memory');
      expect(memory?.selected?.length).toBe(10);
      // The 11th-ranked eligible record (lowest confidence, mem-eligible-10) is the one
      // the top-10 slice cuts.
      const sliceCut = memory?.suppressed?.find((record) => record.id === 'mem-eligible-10');
      expect(sliceCut?.reason).toContain('eligible (');
      expect(sliceCut?.reason).toContain('outside the top-10 prompt slice');
      expect(sliceCut?.reason).toContain('budget-limited, not a trust problem');
      expect(sliceCut?.reason).not.toBe('outside prompt limit');

      const belowFloor = memory?.suppressed?.find((record) => record.id === 'mem-below-floor');
      expect(belowFloor?.reason).toContain('confidence');
      expect(belowFloor?.reason).not.toBe('not reviewed');
      expect(belowFloor?.reason).not.toBe(`confidence below ${60}`);
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes visible Agent orchestration without spawning hidden work', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const now = Date.now();
      const agents = [
        {
          id: 'agent-alpha',
          task: 'Investigate auth flow and report user-facing risks.',
          template: 'engineer',
          tools: ['read', 'find'],
          status: 'running',
          startedAt: now - 5_000,
          progress: 'Reading auth modules and collecting route evidence.',
          toolCallCount: 2,
          context: 'Bounded local project context for auth work.',
          model: 'gpt-4.1',
          provider: 'openai',
          usage: { inputTokens: 120, outputTokens: 40 },
        },
        {
          id: 'agent-beta',
          task: 'Cancelled browser setup investigation.',
          template: 'researcher',
          tools: ['read'],
          status: 'cancelled',
          startedAt: now - 10_000,
          completedAt: now - 1_000,
          progress: 'Cancelled by operator.',
          toolCallCount: 1,
        },
      ];
      const remoteContract = {
        id: 'runner:agent-alpha',
        runnerId: 'agent-alpha',
        poolId: 'ops',
        label: 'Remote auth engineer',
        sourceTransport: 'acp',
        trustClass: 'self-hosted-acp',
        template: 'engineer',
        capabilityCeiling: {
          allowedTools: ['read', 'find'],
          capabilityCeilingTools: ['read', 'find'],
          executionProtocol: 'gather-plan-apply',
          reviewMode: 'wrfc',
          communicationLane: 'parent-only',
          orchestrationDepth: 1,
          successCriteria: ['auth risks mapped'],
          requiredEvidence: ['diff', 'tests'],
          writeScope: ['src/auth/**'],
        },
        createdAt: now - 6_000,
        lastUpdatedAt: now - 2_000,
        transport: {
          state: 'connected',
          connectedAt: now - 6_000,
          messageCount: 4,
          errorCount: 0,
        },
      };
      const remoteArtifact = {
        id: 'artifact-agent-beta',
        runnerId: 'agent-beta',
        createdAt: now - 800,
        runnerContract: {
          ...remoteContract,
          id: 'runner:agent-beta',
          runnerId: 'agent-beta',
          label: 'Browser setup researcher',
          template: 'researcher',
        },
        task: {
          task: 'Cancelled browser setup investigation.',
          status: 'cancelled',
          startedAt: now - 10_000,
          completedAt: now - 1_000,
          summary: 'Operator cancelled the browser setup investigation before follow-up work.',
        },
        evidence: {
          toolCallCount: 1,
          messageCount: 2,
          errorCount: 0,
          transportState: 'connected',
          hasKnowledgeInjections: false,
        },
        knowledgeInjections: [],
      };
      const durableAlphaReceipt = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'remote-alpha-closeout-receipt.json',
        text: JSON.stringify({
          receipt: 'Remote auth evidence exported with metadata-only redaction.',
        }),
        metadata: {
          purpose: 'connected-host-remote-runner-closeout-receipt',
          runnerId: 'agent-alpha',
          status: 'succeeded',
          task: 'Investigate auth flow and report user-facing risks.',
          summary: 'Connected host exported remote auth evidence for closeout review.',
          toolCallCount: 3,
          messageCount: 5,
          errorCount: 0,
          sourceArtifactId: 'remote-alpha-export',
          redaction: 'metadata-only',
        },
      });
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      Object.assign(readModels, {
        remoteRuntime: {
          captureOutcomes: {
            getSnapshot: () => ({
              records: [{
                id: 'capture-alpha-live',
                runnerId: 'agent-alpha',
                kind: 'capture',
                status: 'succeeded',
                task: 'Investigate auth flow and report user-facing risks.',
                summary: 'Captured remote test output with token=REMOTESECRET and exported bounded logs.',
                captureId: 'capture-alpha-1',
                exportId: 'export-alpha-1',
                artifactId: 'remote-alpha-live-artifact',
                completedAt: now - 500,
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.remote-runtime.outcome.v1',
                publicationGuarantee: 'daemon publishes remote capture and closeout outcomes token=remote-outcome-secret',
                publisher: 'goodvibes-daemon',
                provenance: ['method remoteRuntime.captureOutcomes.list', 'sourceTool remote-runtime'],
                cursor: 'remote-cursor-1',
                receiptId: 'remote-alpha-live-receipt',
              }],
            }),
          },
          workspaceIsolation: new Map([
            ['agent-alpha', {
              workspaceId: 'workspace-alpha',
              runnerId: 'agent-alpha',
              status: 'ready',
              isolationKind: 'worktree',
              label: 'Auth isolated worktree',
              worktreePath: `/tmp/token=PATHSECRET/auth-worktree`,
              branch: 'agent/auth-risk-review',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.remote-runtime.workspace.v1',
              publicationGuarantee: 'daemon publishes remote workspace isolation secret=remote-workspace-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method remoteRuntime.workspaceIsolation.list', 'sourceTool remote-runtime'],
              cursor: 'remote-workspace-cursor-1',
              receiptId: 'workspace-alpha-receipt',
            }],
          ]),
        },
      });
      const alphaWorkPlan = fixture.context.workspace.workPlanStore!.addItem('Investigate auth flow and report user-facing risks', {
        status: 'in_progress',
        owner: 'agent',
        source: 'agent_work_plan',
        notes: 'Agent dispatch receipt 2026-06-06T00:00:00.000Z; agent agent-alpha; route agent { mode: "spawn" }; cohort auth-work; request investigate auth risks',
        linked: { agentId: 'agent-alpha' },
      });
      const betaWorkPlan = fixture.context.workspace.workPlanStore!.addItem('Cancelled browser setup investigation', {
        status: 'done',
        owner: 'agent',
        source: 'agent_work_plan',
        notes: 'Agent dispatch receipt 2026-06-06T00:00:01.000Z; agent agent-beta; route agent { mode: "batch-spawn" }; cohort browser-work; request check browser setup',
        linked: { agentId: 'agent-beta' },
      });
      Object.assign(fixture.context.ops as unknown as Record<string, unknown>, {
        agentManager: {
          exportState: () => agents,
        },
        remoteRuntime: {
          listContracts: () => [remoteContract],
          listPools: () => [{
            id: 'ops',
            label: 'Ops Pool',
            trustClass: 'self-hosted-acp',
            preferredTemplate: 'engineer',
            maxRunners: 2,
            runnerIds: ['agent-alpha'],
            createdAt: now - 6_000,
            lastUpdatedAt: now - 2_000,
          }],
          listArtifacts: () => [remoteArtifact],
        },
      });
      registerStubTool(fixture.toolRegistry, 'agent');
      registerStubTool(fixture.toolRegistry, 'remote');

      const summary = await executeHarnessJson<{
        readonly assistant?: { readonly lanes: readonly { readonly id: string; readonly state: string; readonly routes: readonly string[] }[] };
        readonly agentOrchestration?: {
          readonly status: string;
          readonly toolRegistered: boolean;
          readonly agents: number;
          readonly running: number;
          readonly cancellable: number;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.agentOrchestration?.status).toBe('attention');
      expect(summary.agentOrchestration?.toolRegistered).toBe(true);
      expect(summary.agentOrchestration?.agents).toBe(2);
      expect(summary.agentOrchestration?.running).toBe(1);
      expect(summary.agentOrchestration?.cancellable).toBe(1);
      const backgroundLane = summary.assistant?.lanes.find((lane) => lane.id === 'background-work');
      expect(backgroundLane?.state).toBe('attention');
      expect(backgroundLane?.routes).toContain('agent_harness mode:"agent_orchestration"');

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly agents: number;
          readonly running: number;
          readonly cancellable: number;
          readonly toolRegistered: boolean;
          readonly serialDefault: boolean;
          readonly managedPlanStatus: string;
        };
        readonly managedExecutionPlan: {
          readonly status: string;
          readonly summary: string;
          readonly milestones: readonly {
            readonly id: string;
            readonly status: string;
            readonly cancellableRoutes?: readonly string[];
            readonly contracts?: number;
            readonly artifacts?: number;
            readonly readModelOutcomes?: number;
            readonly workspaceEvidence?: number;
            readonly linkedWorkPlanItems?: number;
            readonly dispatchReceipts?: number;
            readonly autoAttachedRemoteArtifacts?: number;
            readonly liveRemoteOutcomes?: number;
            readonly routes?: { readonly contracts?: string; readonly artifacts?: string };
          }[];
          readonly workItems: readonly {
            readonly planItemId: string;
            readonly lane: string;
            readonly milestoneId: string;
            readonly status: string;
            readonly remoteContract?: {
              readonly runnerId: string;
              readonly transportState: string;
              readonly allowedTools: readonly string[];
              readonly capabilityCeilingTools: readonly string[];
              readonly orchestrationDepth: number | null;
              readonly requiredEvidence: readonly string[];
            } | null;
            readonly artifactTrail: readonly {
              readonly id: string;
              readonly runnerId: string;
              readonly modelRoute: string;
            }[];
            readonly liveOutcomeTrail: readonly {
              readonly id: string;
              readonly runnerId: string;
              readonly status: string;
              readonly summary: string | null;
              readonly sourcePath: string;
              readonly modelRoute: string;
              readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
            }[];
            readonly workspaceEvidence: readonly {
              readonly id: string;
              readonly runnerId: string;
              readonly status: string;
              readonly worktreeRef: string | null;
              readonly sourcePath: string;
              readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
            }[];
            readonly workPlanLinks: readonly {
              readonly itemId: string;
              readonly dispatchReceiptCount: number;
              readonly latestDispatchReceipt: string | null;
              readonly routes: { readonly inspect: string; readonly markDone: string };
            }[];
            readonly closeout: {
              readonly status: string;
              readonly workPlanItemCount: number;
              readonly dispatchReceiptCount: number;
              readonly remoteArtifactCount: number;
              readonly remoteReceiptCount: number;
              readonly remoteOutcomeCount: number;
              readonly workspaceEvidenceCount: number;
              readonly autoAttachReason: string | null;
              readonly workPlanItems: readonly { readonly itemId: string; readonly dispatchReceiptCount: number }[];
              readonly autoAttachedRemoteArtifacts: readonly { readonly id: string; readonly modelRoute: string; readonly receipt?: boolean; readonly redaction?: string }[];
              readonly liveRemoteOutcomes: readonly { readonly id: string; readonly summary: string | null; readonly certification?: { readonly schemaStatus: string; readonly missingSignals: readonly string[] } }[];
              readonly workspaceEvidence: readonly { readonly id: string; readonly worktreeRef: string | null; readonly certification?: { readonly schemaStatus: string; readonly missingSignals: readonly string[] } }[];
              readonly reviewRoutes: readonly string[];
              readonly updateRoutes: readonly string[];
              readonly policy: string;
            };
            readonly reviewGate: {
              readonly status: string;
              readonly requiredEvidence: readonly string[];
              readonly modelRoutes: readonly string[];
            };
            readonly nextAction: string;
          }[];
          readonly remoteEvidence: {
            readonly status: string;
            readonly pools: readonly { readonly id: string; readonly runnerIds: readonly string[] }[];
            readonly contracts: readonly { readonly runnerId: string; readonly reviewMode: string }[];
            readonly artifacts: readonly { readonly id: string; readonly runnerId: string; readonly receipt?: boolean; readonly redaction?: string }[];
            readonly liveOutcomes: readonly {
              readonly id: string;
              readonly summary: string | null;
              readonly sourcePath: string;
              readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
            }[];
            readonly workspaceEvidence: readonly {
              readonly id: string;
              readonly worktreeRef: string | null;
              readonly sourcePath: string;
              readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
            }[];
            readonly sourceCounts: Record<string, number>;
            readonly policy: string;
          };
          readonly modelAccess: { readonly remoteContracts: string; readonly remoteArtifacts: string };
          readonly policy: string;
        };
        readonly agents: readonly {
          readonly agentId: string;
          readonly status: string;
          readonly routes: { readonly cancel: string; readonly message: string };
          readonly managedPlanCard?: { readonly lane: string; readonly reviewGate: { readonly status: string } };
          readonly context?: string | null;
        }[];
        readonly decisionCards: readonly { readonly id: string; readonly status: string; readonly modelRoute?: string; readonly userRoute?: string }[];
        readonly modelAccess: { readonly spawn: string; readonly batchSpawn: string; readonly harness: string };
        readonly policy: string;
      }>(fixture, { mode: 'agent_orchestration', includeParameters: true });
      expect(posture.summary).toMatchObject({
        agents: 2,
        running: 1,
        cancellable: 1,
        toolRegistered: true,
        serialDefault: true,
        managedPlanStatus: 'active',
      });
      expect(posture.managedExecutionPlan.status).toBe('active');
      expect(posture.managedExecutionPlan.summary).toContain('2 visible agents');
      expect(posture.managedExecutionPlan.summary).toContain('2 dispatch receipts');
      expect(posture.managedExecutionPlan.policy).toContain('read-only');
      const agentWorkMilestone = posture.managedExecutionPlan.milestones.find((milestone) => milestone.id === 'visible-agent-work');
      expect(agentWorkMilestone?.status).toBe('active');
      expect(agentWorkMilestone?.cancellableRoutes?.join('\n')).toContain('agent-alpha');
      const remoteMilestone = posture.managedExecutionPlan.milestones.find((milestone) => milestone.id === 'remote-runner-evidence');
      expect(remoteMilestone?.status).toBe('ready');
      expect(remoteMilestone?.contracts).toBe(1);
      expect(remoteMilestone?.artifacts).toBe(2);
      expect(remoteMilestone?.readModelOutcomes).toBe(1);
      expect(remoteMilestone?.workspaceEvidence).toBe(1);
      expect(remoteMilestone?.routes?.contracts).toBe('remote { mode: "contracts", view: "summary" }');
      const closeoutMilestone = posture.managedExecutionPlan.milestones.find((milestone) => milestone.id === 'review-and-closeout');
      expect(closeoutMilestone?.linkedWorkPlanItems).toBe(2);
      expect(closeoutMilestone?.dispatchReceipts).toBe(2);
      expect(closeoutMilestone?.autoAttachedRemoteArtifacts).toBe(2);
      expect(closeoutMilestone?.liveRemoteOutcomes).toBe(1);
      expect(closeoutMilestone?.workspaceEvidence).toBe(1);
      expect(closeoutMilestone?.routes as unknown as readonly string[]).toContain('agent_work_plan action:"list"');
      expect(posture.managedExecutionPlan.remoteEvidence.status).toBe('ready');
      expect(posture.managedExecutionPlan.remoteEvidence.pools[0]?.runnerIds).toEqual(['agent-alpha']);
      expect(posture.managedExecutionPlan.remoteEvidence.contracts[0]?.runnerId).toBe('agent-alpha');
      expect(posture.managedExecutionPlan.remoteEvidence.contracts[0]?.reviewMode).toBe('wrfc');
      expect(posture.managedExecutionPlan.remoteEvidence.artifacts[0]?.id).toBe('artifact-agent-beta');
      expect(posture.managedExecutionPlan.remoteEvidence.artifacts.find((artifact) => artifact.id === durableAlphaReceipt.id)).toMatchObject({
        runnerId: 'agent-alpha',
        receipt: true,
        redaction: 'metadata-only',
      });
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.id).toBe('capture-alpha-live');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.summary).toContain('token=<redacted>');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.summary).not.toContain('REMOTESECRET');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.sourcePath).toContain('context.platform.readModels.remoteRuntime.captureOutcomes');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.schemaStatus).toBe('certified');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.receiptId).toBe('remote-alpha-live-receipt');
      expect(posture.managedExecutionPlan.remoteEvidence.liveOutcomes[0]?.certification.missingSignals).toEqual([]);
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.id).toBe('workspace-alpha');
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.worktreeRef).toContain('auth-worktree');
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.worktreeRef).not.toContain('PATHSECRET');
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.schemaStatus).toBe('certified');
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.publicationGuarantee).toContain('secret=<redacted>');
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.receiptId).toBe('workspace-alpha-receipt');
      expect(posture.managedExecutionPlan.remoteEvidence.workspaceEvidence[0]?.certification.missingSignals).toEqual([]);
      expect(posture.managedExecutionPlan.remoteEvidence.sourceCounts['context.platform.readModels.remoteRuntime.captureOutcomes.getSnapshot().records[0]']).toBe(1);
      expect(posture.managedExecutionPlan.remoteEvidence.policy).toContain('read-only');
      expect(posture.managedExecutionPlan.modelAccess.remoteContracts).toContain('remote');
      const alphaPlanItem = posture.managedExecutionPlan.workItems.find((item) => item.planItemId === 'agent:agent-alpha');
      expect(alphaPlanItem?.lane).toBe('remote-runner');
      expect(alphaPlanItem?.milestoneId).toBe('visible-agent-work');
      expect(alphaPlanItem?.artifactTrail[0]?.id).toBe(durableAlphaReceipt.id);
      expect(alphaPlanItem?.artifactTrail[0]?.modelRoute).toContain('agent_artifacts show');
      expect(alphaPlanItem?.liveOutcomeTrail[0]?.id).toBe('capture-alpha-live');
      expect(alphaPlanItem?.liveOutcomeTrail[0]?.summary).toContain('token=<redacted>');
      expect(alphaPlanItem?.liveOutcomeTrail[0]?.certification.missingSignals).toEqual([]);
      expect(alphaPlanItem?.workspaceEvidence[0]?.id).toBe('workspace-alpha');
      expect(alphaPlanItem?.workspaceEvidence[0]?.certification.missingSignals).toEqual([]);
      expect(alphaPlanItem?.remoteContract?.runnerId).toBe('agent-alpha');
      expect(alphaPlanItem?.remoteContract?.transportState).toBe('connected');
      expect(alphaPlanItem?.remoteContract?.allowedTools).toContain('read');
      expect(alphaPlanItem?.remoteContract?.capabilityCeilingTools).toContain('find');
      expect(alphaPlanItem?.remoteContract?.orchestrationDepth).toBe(1);
      expect(alphaPlanItem?.remoteContract?.requiredEvidence).toContain('tests');
      expect(alphaPlanItem?.workPlanLinks[0]?.itemId).toBe(alphaWorkPlan.id);
      expect(alphaPlanItem?.workPlanLinks[0]?.dispatchReceiptCount).toBe(1);
      expect(alphaPlanItem?.workPlanLinks[0]?.latestDispatchReceipt).toContain('agent-alpha');
      expect(alphaPlanItem?.workPlanLinks[0]?.routes.inspect).toContain(alphaWorkPlan.id);
      expect(alphaPlanItem?.closeout.status).toBe('pending-work');
      expect(alphaPlanItem?.closeout.workPlanItemCount).toBe(1);
      expect(alphaPlanItem?.closeout.dispatchReceiptCount).toBe(1);
      expect(alphaPlanItem?.closeout.remoteArtifactCount).toBe(1);
      expect(alphaPlanItem?.closeout.remoteReceiptCount).toBe(1);
      expect(alphaPlanItem?.closeout.remoteOutcomeCount).toBe(1);
      expect(alphaPlanItem?.closeout.workspaceEvidenceCount).toBe(1);
      expect(alphaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.id).toBe(durableAlphaReceipt.id);
      expect(alphaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.modelRoute).toContain('agent_artifacts show');
      expect(alphaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.redaction).toBe('metadata-only');
      expect(alphaPlanItem?.closeout.liveRemoteOutcomes[0]?.id).toBe('capture-alpha-live');
      expect(alphaPlanItem?.closeout.liveRemoteOutcomes[0]?.certification?.schemaStatus).toBe('certified');
      expect(alphaPlanItem?.closeout.workspaceEvidence[0]?.id).toBe('workspace-alpha');
      expect(alphaPlanItem?.closeout.workspaceEvidence[0]?.certification?.schemaStatus).toBe('certified');
      expect(alphaPlanItem?.closeout.reviewRoutes.join('\n')).toContain(alphaWorkPlan.id);
      expect(alphaPlanItem?.closeout.reviewRoutes.join('\n')).toContain(`agent_artifacts show artifactId:"${durableAlphaReceipt.id}"`);
      expect(alphaPlanItem?.closeout.reviewRoutes.join('\n')).toContain('agent_orchestration_agent');
      expect(alphaPlanItem?.reviewGate.status).toBe('pending-work');
      expect(alphaPlanItem?.reviewGate.requiredEvidence).toContain('diff');
      expect(alphaPlanItem?.reviewGate.requiredEvidence).toContain('workspace/worktree isolation evidence');
      expect(alphaPlanItem?.reviewGate.requiredEvidence).toContain('live remote capture/export outcome evidence');
      expect(alphaPlanItem?.nextAction).toContain('wait/status');
      const betaPlanItem = posture.managedExecutionPlan.workItems.find((item) => item.planItemId === 'agent:agent-beta');
      expect(betaPlanItem?.lane).toBe('visible-agent');
      expect(betaPlanItem?.milestoneId).toBe('review-and-closeout');
      expect(betaPlanItem?.artifactTrail[0]?.id).toBe('artifact-agent-beta');
      expect(betaPlanItem?.artifactTrail[0]?.modelRoute).toContain('remote { mode: "review"');
      expect(betaPlanItem?.workPlanLinks[0]?.itemId).toBe(betaWorkPlan.id);
      expect(betaPlanItem?.closeout.status).toBe('evidence-ready');
      expect(betaPlanItem?.closeout.dispatchReceiptCount).toBe(1);
      expect(betaPlanItem?.closeout.remoteArtifactCount).toBe(1);
      expect(betaPlanItem?.closeout.autoAttachReason).toContain('runnerId');
      expect(betaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.id).toBe('artifact-agent-beta');
      expect(betaPlanItem?.closeout.autoAttachedRemoteArtifacts[0]?.modelRoute).toContain('remote { mode: "review"');
      expect(betaPlanItem?.closeout.reviewRoutes.join('\n')).toContain('artifact-agent-beta');
      expect(betaPlanItem?.closeout.reviewRoutes.join('\n')).toContain(betaWorkPlan.id);
      expect(betaPlanItem?.closeout.updateRoutes.join('\n')).toContain('status:"done"');
      expect(betaPlanItem?.closeout.policy).toContain('read-only');
      expect(betaPlanItem?.reviewGate.status).toBe('artifact-ready');
      expect(betaPlanItem?.reviewGate.modelRoutes.join('\n')).toContain('artifact-agent-beta');
      expect(posture.modelAccess.spawn).toBe('agent { mode: "spawn" }');
      expect(posture.modelAccess.batchSpawn).toBe('agent { mode: "batch-spawn" }');
      expect(posture.modelAccess.harness).toBe('agent_harness mode:"agent_orchestration"');
      expect(posture.decisionCards.find((card) => card.id === 'visible-batch-spawn')?.status).toBe('ready');
      expect(posture.decisionCards.find((card) => card.id === 'managed-multi-runner-plan')?.status).toBe('ready');
      expect(posture.decisionCards.find((card) => card.id === 'managed-multi-runner-plan')?.userRoute).toContain('/work submit-file');
      expect(posture.decisionCards.find((card) => card.id === 'hidden-fanout-blocked')?.status).toBe('blocked');
      expect(posture.agents[0]?.routes.cancel).toBe('agent { mode: "cancel", agentId: "agent-alpha" }');
      expect(posture.agents[0]?.routes.message).toBe('agent { mode: "message", agentId: "agent-alpha" }');
      expect(posture.agents[0]?.managedPlanCard?.lane).toBe('remote-runner');
      expect(posture.agents[0]?.managedPlanCard?.reviewGate.status).toBe('pending-work');
      expect(posture.agents[0]?.context).toContain('project context');
      expect(posture.policy).toContain('hidden fanout is blocked');

      const detail = await executeHarnessJson<{
        readonly agentId: string;
        readonly status: string;
        readonly task: string;
        readonly routes: { readonly inspect: string; readonly wait: string };
        readonly tools: readonly string[];
        readonly usage: { readonly inputTokens: number };
        readonly managedPlanCard?: {
          readonly lane: string;
          readonly remoteContract?: { readonly runnerId: string; readonly transportState: string } | null;
          readonly liveOutcomeTrail: readonly { readonly id: string; readonly summary: string | null; readonly certification?: { readonly missingSignals: readonly string[] } }[];
          readonly workspaceEvidence: readonly { readonly id: string; readonly worktreeRef: string | null; readonly certification?: { readonly missingSignals: readonly string[] } }[];
          readonly workPlanLinks: readonly { readonly itemId: string; readonly latestDispatchReceipt: string | null }[];
          readonly closeout: { readonly dispatchReceiptCount: number; readonly remoteReceiptCount: number; readonly remoteOutcomeCount: number; readonly workspaceEvidenceCount: number; readonly reviewRoutes: readonly string[] };
        };
      }>(fixture, { mode: 'agent_orchestration_agent', agentId: 'agent-alpha' });
      expect(detail.agentId).toBe('agent-alpha');
      expect(detail.status).toBe('running');
      expect(detail.task).toContain('auth flow');
      expect(detail.routes.inspect).toBe('agent { mode: "get", agentId: "agent-alpha" }');
      expect(detail.routes.wait).toBe('agent { mode: "wait", agentId: "agent-alpha" }');
      expect(detail.tools).toEqual(['read', 'find']);
      expect(detail.usage.inputTokens).toBe(120);
      expect(detail.managedPlanCard?.lane).toBe('remote-runner');
      expect(detail.managedPlanCard?.remoteContract?.runnerId).toBe('agent-alpha');
      expect(detail.managedPlanCard?.remoteContract?.transportState).toBe('connected');
      expect(detail.managedPlanCard?.liveOutcomeTrail[0]?.id).toBe('capture-alpha-live');
      expect(detail.managedPlanCard?.liveOutcomeTrail[0]?.certification?.missingSignals).toEqual([]);
      expect(detail.managedPlanCard?.workspaceEvidence[0]?.id).toBe('workspace-alpha');
      expect(detail.managedPlanCard?.workspaceEvidence[0]?.certification?.missingSignals).toEqual([]);
      expect(detail.managedPlanCard?.workPlanLinks[0]?.itemId).toBe(alphaWorkPlan.id);
      expect(detail.managedPlanCard?.workPlanLinks[0]?.latestDispatchReceipt).toContain('agent-alpha');
      expect(detail.managedPlanCard?.closeout.dispatchReceiptCount).toBe(1);
      expect(detail.managedPlanCard?.closeout.remoteReceiptCount).toBe(1);
      expect(detail.managedPlanCard?.closeout.remoteOutcomeCount).toBe(1);
      expect(detail.managedPlanCard?.closeout.workspaceEvidenceCount).toBe(1);
      expect(detail.managedPlanCard?.closeout.reviewRoutes.join('\n')).toContain(alphaWorkPlan.id);
      expect(detail.managedPlanCard?.closeout.reviewRoutes.join('\n')).toContain(`agent_artifacts show artifactId:"${durableAlphaReceipt.id}"`);
      expect(JSON.stringify({ posture, detail })).not.toContain('remote-outcome-secret');
      expect(JSON.stringify({ posture, detail })).not.toContain('remote-workspace-secret');

      const filtered = await executeHarnessJson<{
        readonly returned: number;
        readonly agents: readonly { readonly agentId: string }[];
      }>(fixture, { mode: 'agent_orchestration', query: 'auth' });
      expect(filtered.returned).toBe(1);
      expect(filtered.agents[0]?.agentId).toBe('agent-alpha');

      const queue = await executeHarnessJson<{
        readonly queue: readonly {
          readonly queueItemId: string;
          readonly modelRoute: string;
          readonly inspectRoute: string;
          readonly cancelRoute?: string;
          readonly createRoute?: string;
          readonly batchCreateRoute?: string;
        }[];
      }>(fixture, { mode: 'autonomy_queue', query: 'subagent', includeParameters: true });
      const subagents = queue.queue.find((item) => item.queueItemId === 'delegated-subagents');
      expect(subagents?.modelRoute).toBe('agent_harness mode:"agent_orchestration"');
      expect(subagents?.inspectRoute).toBe('agent_harness mode:"agent_orchestration"');
      expect(subagents?.cancelRoute).toBe('agent { mode: "cancel", agentId: "..." }');
      expect(subagents?.createRoute).toContain('agent { mode: "spawn"');
      expect(subagents?.batchCreateRoute).toContain('agent { mode: "batch-spawn"');
    } finally {
      fixture.cleanup();
    }
  });

  test('saves redacted setup smoke evidence artifacts when user-run output is provided', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const smokeRun = await executeHarnessJson<{
        readonly status: string;
        readonly artifact: {
          readonly status: string;
          readonly artifactId?: string;
          readonly filename?: string;
          readonly purpose?: string;
          readonly evidenceFields?: readonly { readonly id: string; readonly preview: string }[];
          readonly inspectRoute?: string;
        };
      }>(fixture, {
        mode: 'run_setup_smoke',
        setupItemId: 'install-smoke',
        confirm: true,
        explicitUserRequest: 'Save the redacted setup smoke evidence.',
        fields: {
          agentBinaryOutput: 'goodvibes-agent 1.0.0\nAuthorization: Bearer binary-secret',
          statusJson: '{"connectedHost":{"token":"host-secret"},"ok":true}',
          firstAssistantTurn: 'Ready. apiKey=assistant-secret',
          notes: 'Operator saw token=query-secret in https://example.test/status?token=query-secret',
        },
      });

      expect(smokeRun.status).toBe('executed');
      expect(smokeRun.artifact.status).toBe('saved');
      expect(smokeRun.artifact.artifactId).toBe('artifact-1');
      expect(smokeRun.artifact.filename).toContain('setup-smoke-');
      expect(smokeRun.artifact.purpose).toBe('agent-setup-smoke-evidence');
      expect(smokeRun.artifact.inspectRoute).toContain('agent_artifacts');
      expect(smokeRun.artifact.evidenceFields?.map((field) => field.id)).toEqual([
        'agentBinaryOutput',
        'statusJson',
        'firstAssistantTurn',
        'notes',
      ]);
      expect(JSON.stringify(smokeRun)).not.toContain('binary-secret');
      expect(JSON.stringify(smokeRun)).not.toContain('host-secret');
      expect(JSON.stringify(smokeRun)).not.toContain('assistant-secret');
      expect(JSON.stringify(smokeRun)).not.toContain('query-secret');

      const artifact = artifacts.store.list(1)[0];
      expect(artifact?.metadata).toMatchObject({
        purpose: 'agent-setup-smoke-evidence',
        source: 'agent-harness-run-setup-smoke',
        smokeStatus: 'blocked',
        evidenceFields: ['agentBinaryOutput', 'statusJson', 'firstAssistantTurn', 'notes'],
      });
      expect(JSON.stringify(artifact?.metadata)).not.toContain('binary-secret');
      expect(JSON.stringify(artifact?.metadata)).not.toContain('host-secret');
      expect(JSON.stringify(artifact?.metadata)).not.toContain('assistant-secret');
      expect(JSON.stringify(artifact?.metadata)).not.toContain('query-secret');
      const saved = await artifacts.store.readContent('artifact-1');
      const content = saved.buffer.toString('utf-8');
      expect(content).toContain('GoodVibes Agent Setup Smoke Evidence');
      expect(content).toContain('Agent binary output');
      expect(content).toContain('<redacted>');
      expect(content).not.toContain('binary-secret');
      expect(content).not.toContain('host-secret');
      expect(content).not.toContain('assistant-secret');
      expect(content).not.toContain('query-secret');

      const summary = await executeHarnessJson<{
        readonly assistant?: {
          readonly lanes?: readonly {
            readonly id: string;
            readonly summary: string;
            readonly nextAction: string;
          }[];
        };
        readonly setupPosture?: {
          readonly setupSmokeEvidence?: {
            readonly status: string;
            readonly artifactId: string;
            readonly result: string;
            readonly evidenceFields: readonly string[];
            readonly inspectRoute: string;
          };
          readonly setupSmokeHistory?: {
            readonly status: string;
            readonly total: number;
            readonly trend: string;
            readonly latestResult: string;
            readonly resultCounts: Record<string, number>;
            readonly blockedCheckFrequency: readonly { readonly checkId: string; readonly count: number }[];
            readonly recent: readonly { readonly artifactId: string; readonly result: string }[];
          };
          readonly setupWizard?: {
            readonly currentStepId: string;
            readonly currentStepLabel: string;
            readonly _diagnostic: {
              readonly repeatedBlocker?: {
                readonly setupItemId: string;
                readonly checkId: string;
                readonly count: number;
              } | null;
              readonly smokeHistory: {
                readonly status: string;
                readonly total: number;
                readonly latestResult: string;
              };
            };
          };
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.setupPosture?.setupSmokeEvidence).toMatchObject({
        status: 'saved',
        artifactId: 'artifact-1',
        result: 'blocked',
        evidenceFields: ['agentBinaryOutput', 'statusJson', 'firstAssistantTurn', 'notes'],
      });
      expect(summary.setupPosture?.setupSmokeEvidence?.inspectRoute).toContain('agent_artifacts');
      expect(summary.setupPosture?.setupSmokeHistory).toMatchObject({
        status: 'available',
        total: 1,
        trend: 'first-run',
        latestResult: 'blocked',
      });
      expect(summary.setupPosture?.setupSmokeHistory?.resultCounts.blocked).toBe(1);
      expect(summary.setupPosture?.setupSmokeHistory?.blockedCheckFrequency.map((entry) => entry.checkId)).toContain('connected-host-auth');
      expect(summary.setupPosture?.setupSmokeHistory?.recent[0]).toMatchObject({
        artifactId: 'artifact-1',
        result: 'blocked',
      });
      expect(summary.setupPosture?.setupWizard?.currentStepId).toBe('connected-host-auth');
      expect(summary.setupPosture?.setupWizard?.currentStepLabel).toBe('Connected-host auth');
      expect(summary.setupPosture?.setupWizard?._diagnostic.repeatedBlocker).toMatchObject({
        setupItemId: 'connected-host-auth',
        checkId: 'connected-host-auth',
        count: 1,
      });
      expect(summary.setupPosture?.setupWizard?._diagnostic.smokeHistory).toMatchObject({
        status: 'available',
        total: 1,
        latestResult: 'blocked',
      });
      const setupLane = summary.assistant?.lanes?.find((lane) => lane.id === 'setup');
      expect(setupLane?.summary).toContain('Last smoke blocked');
      expect(setupLane?.summary).toContain('Trend first-run');
      expect(setupLane?.nextAction).toContain('saved smoke artifact');
    } finally {
      fixture.cleanup();
    }
  });

  test('promotes ready setup smoke evidence into a confirmed setup closeout path', async () => {
    await withPairedHost(async (port) => {
      const artifacts = createHarnessArtifactStore();
      const fixture = makeFixture({ artifactStore: artifacts.store, controlPlaneEnabled: true, controlPlanePort: port });
      try {
        if (!fixture.secretsManager) throw new Error('Expected fixture secrets manager.');
        await fixture.secretsManager.set('OPENAI_API_KEY', 'provider-secret-for-closeout');
        writeConnectedHostOperatorToken(fixture);

        const smokeRun = await executeHarnessJson<{
          readonly result: string;
          readonly smokeStatus: string;
          readonly blockedChecks: readonly string[];
          readonly artifact: { readonly status: string; readonly artifactId?: string };
        }>(fixture, {
          mode: 'run_setup_smoke',
          setupItemId: 'install-smoke',
          confirm: true,
          explicitUserRequest: 'Save final setup smoke evidence for closeout.',
          fields: {
            agentBinaryOutput: 'goodvibes-agent 1.0.0\nstatus ok',
            statusJson: '{"connectedHost":{"reachable":true},"provider":"openai"}',
            setupPostureOutput: 'setup posture reviewed; no critical blockers',
            firstAssistantTurn: 'Ready. Active model route is openai/gpt-4.1.',
          },
        });
        expect(smokeRun.result).toBe('ready-for-user-run');
        expect(smokeRun.smokeStatus).toBe('ready-to-run');
        expect(smokeRun.blockedChecks).toEqual([]);
        expect(smokeRun.artifact.status).toBe('saved');

        const posture = await executeHarnessJson<{
          readonly setupCloseout: {
            readonly status: string;
            readonly label: string;
            readonly primaryStepId: string | null;
            readonly modelRoute: string;
            readonly userRoute: string;
            readonly requiresConfirmation: boolean;
            readonly evidence: readonly string[];
          };
          readonly setupWizard: {
            readonly _diagnostic: {
              readonly closeout: {
                readonly status: string;
                readonly primaryStepId: string | null;
                readonly modelRoute: string;
              };
            };
          };
          readonly readinessPlan: readonly { readonly setupItemId: string; readonly status: string; readonly blocksAutonomy: boolean }[];
        }>(fixture, { mode: 'setup_posture', includeParameters: true });

        expect(posture.readinessPlan
          .filter((item) => item.blocksAutonomy)
          .every((item) => item.status !== 'blocked')).toBe(true);
        expect(posture.setupCloseout).toMatchObject({
          status: 'ready-to-finish',
          label: 'Finish setup',
          primaryStepId: 'finish-onboarding',
          requiresConfirmation: true,
        });
        expect(posture.setupCloseout.modelRoute).toContain('setup action:"finish"');
        expect(posture.setupCloseout.userRoute).toContain('Finish');
        expect(posture.setupCloseout.evidence.join('\n')).toContain('latest setup smoke: ready-for-user-run');
        expect(posture.setupWizard._diagnostic.closeout.status).toBe('ready-to-finish');
        expect(posture.setupWizard._diagnostic.closeout.modelRoute).toContain('setup action:"finish"');

        const finished = await executeHarnessJson<{
          readonly status: string;
          readonly checkMarker: { readonly exists: boolean; readonly source: string | null; readonly mode: string | null };
          readonly completionMarker: { readonly exists: boolean; readonly source: string | null; readonly mode: string | null };
          readonly policy: { readonly effect: string; readonly boundary: string };
        }>(fixture, {
          mode: 'run_workspace_action',
          actionId: 'onboarding-apply-close',
          confirm: true,
          explicitUserRequest: 'Finish Agent onboarding after setup smoke evidence is ready.',
        });
        expect(finished.status).toBe('onboarding_completed');
        expect(finished.checkMarker).toMatchObject({ exists: true, source: 'wizard', mode: 'new' });
        expect(finished.completionMarker).toMatchObject({ exists: true, source: 'wizard', mode: 'new' });
        expect(finished.policy.effect).toBe('confirmed-onboarding-marker-write');
        expect(finished.policy.boundary).toContain('does not mutate provider credentials');

        const after = await executeHarnessJson<{
          readonly setupCloseout: { readonly status: string; readonly label: string; readonly requiresConfirmation: boolean };
        }>(fixture, { mode: 'setup_posture' });
        expect(after.setupCloseout).toMatchObject({
          status: 'complete',
          label: 'Setup complete',
          requiresConfirmation: false,
        });
      } finally {
        fixture.cleanup();
      }
    });
  });

  test('verified native auth does not upgrade an unconfigured provider', async () => {
    await withClearedEnv(PROVIDER_AUTH_ENV_KEYS, () => withPairedHost(async (port) => {
      const fixture = makeFixture({ controlPlaneEnabled: true, controlPlanePort: port });
      try {
        writeConnectedHostOperatorToken(fixture);
        const posture = await executeHarnessJson<{
          readonly readinessPlan: readonly { readonly setupItemId: string; readonly status: string }[];
          readonly setupCloseout: { readonly status: string; readonly primaryStepId: string };
        }>(fixture, { mode: 'setup_posture', includeParameters: true });
        const plan = new Map(posture.readinessPlan.map(item => [item.setupItemId, item.status]));
        expect(plan.get('connected-host-auth')).toBe('ready');
        expect(plan.get('provider-access')).toBe('blocked');
        expect(posture.setupCloseout).toMatchObject({ status: 'blocked', primaryStepId: 'provider-access' });
      } finally { fixture.cleanup(); }
    }));
  });

  test('uses live service probes before recommending connected-host lifecycle repair', async () => {
    const fixture = makeFixture({ controlPlaneEnabled: true, controlPlanePort: 1 });
    try {
      const hostItem = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly signals?: readonly string[];
        readonly recommendedRepairCards?: readonly string[];
        readonly bootstrapPlan?: { readonly status: string; readonly recommendedWhen: string };
        readonly serviceProbe?: {
          readonly status: string;
          readonly enabled: boolean;
          readonly binding: string;
          readonly diagnosticRoute: string;
          readonly issues: readonly string[];
        };
        readonly serviceLifecycleDecision?: {
          readonly status: string;
          readonly recommendedAction: string;
          readonly modelRoute: string;
          readonly reason: string;
          readonly receiptRules: readonly string[];
          readonly blockedMutations: readonly string[];
        };
        readonly repairCards?: readonly {
          readonly id: string;
          readonly state: string;
          readonly recommendation: string;
          readonly liveEvidence?: { readonly probeStatus: string; readonly summary: string };
          readonly outcome?: {
            readonly target: string;
            readonly successCriteria: readonly string[];
            readonly evidenceFields: readonly string[];
            readonly verificationRoute: string;
            readonly recoveryRoute: string;
          };
        }[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });

      expect(hostItem.setupItemId).toBe('connected-host-readiness');
      expect(hostItem.status).toBe('blocked');
      expect(hostItem.serviceProbe).toMatchObject({
        status: 'unreachable',
        enabled: true,
        binding: '127.0.0.1:1',
      });
      expect(hostItem.serviceProbe?.diagnosticRoute).toContain('host action:"service"');
      expect(hostItem.signals?.join('\n')).toContain('runtime connection probe: unreachable 127.0.0.1:1');
      expect(hostItem.serviceLifecycleDecision?.status).toBe('needs-status-receipt');
      expect(hostItem.serviceLifecycleDecision?.recommendedAction).toBe('read-services-status');
      expect(hostItem.serviceLifecycleDecision?.modelRoute).toContain('services.status');
      expect(hostItem.serviceLifecycleDecision?.reason).toContain('status receipt first');
      expect(hostItem.serviceLifecycleDecision?.receiptRules.join('\n')).toContain('running:false');
      expect(hostItem.serviceLifecycleDecision?.blockedMutations.join('\n')).toContain('services.restart');
      expect(hostItem.recommendedRepairCards).toContain('connected-host-status');
      expect(hostItem.recommendedRepairCards).toContain('service-posture');
      expect(hostItem.recommendedRepairCards).toContain('service-status');
      expect(hostItem.recommendedRepairCards).not.toContain('service-install');
      expect(hostItem.recommendedRepairCards).not.toContain('service-start');
      expect(hostItem.recommendedRepairCards).not.toContain('service-restart');
      expect(hostItem.bootstrapPlan?.status).toBe('recommended');
      expect(hostItem.bootstrapPlan?.recommendedWhen).toContain('runtime connection is enabled but unreachable');

      const start = hostItem.repairCards?.find((card) => card.id === 'service-start');
      const install = hostItem.repairCards?.find((card) => card.id === 'service-install');
      const restart = hostItem.repairCards?.find((card) => card.id === 'service-restart');
      expect(start?.state).toBe('available');
      expect(start?.recommendation).toBe('inspect-first');
      expect(start?.liveEvidence?.probeStatus).toBe('unreachable');
      expect(start?.liveEvidence?.summary).toContain('service status');
      expect(start?.outcome?.target).toBe('running-service');
      expect(start?.outcome?.successCriteria.join('\n')).toContain('running:true');
      expect(start?.outcome?.evidenceFields).toContain('actionError');
      expect(start?.outcome?.verificationRoute).toContain('services.status');
      expect(install?.recommendation).toBe('inspect-first');
      expect(install?.outcome?.target).toBe('installed-service');
      expect(restart?.recommendation).toBe('inspect-first');
      expect(restart?.outcome?.target).toBe('restarted-running-service');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes connected-host auth as a token-safe setup blocker', async () => {
    await withClearedEnv(CONNECTED_HOST_AUTH_ENV_KEYS, async () => {
      const fixture = makeFixture();
      try {
        const missing = await executeHarnessJson<{
          readonly setupItemId: string;
          readonly status: string;
          readonly blocksAutonomy: boolean;
          readonly nextAction: string;
          readonly signals?: readonly string[];
          readonly authPosture?: {
            readonly owner: string;
            readonly operatorToken: {
              readonly present: boolean;
              readonly usable: boolean;
              readonly path: string;
              readonly fingerprint?: string;
            };
            readonly routes: {
              readonly reviewCommand: string;
              readonly connectedHostStatus: string;
              readonly pairingPosture: string;
              readonly qrPairingRoute: string;
              readonly manualTokenRoute: string;
              readonly provisionTokenRoute: string;
              readonly tokenProvisioningOwner: string;
              readonly tokenProvisioningSource: string;
            };
          };
        }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-auth' });

        expect(missing.setupItemId).toBe('connected-host-auth');
        expect(missing.status).toBe('blocked');
        expect(missing.blocksAutonomy).toBe(true);
        expect(missing.nextAction).toContain('confirmed connected-host token provisioning route');
        expect(missing.signals?.join('\n')).toContain('operator token: missing');
        expect(missing.signals?.join('\n')).toContain('setup action:"token"');
        expect(missing.signals?.join('\n')).toContain('getOrCreateCompanionToken');
        expect(missing.authPosture?.owner).toBe('connected-host');
        expect(missing.authPosture?.operatorToken).toMatchObject({ present: false, usable: false });
        expect(missing.authPosture?.routes.reviewCommand).toBe('/auth review');
        expect(missing.authPosture?.routes.connectedHostStatus).toContain('host action:"status"');
        expect(missing.authPosture?.routes.pairingPosture).toContain('pairing_posture');
        expect(missing.authPosture?.routes.qrPairingRoute).toContain('qr-pairing');
        expect(missing.authPosture?.routes.manualTokenRoute).toContain('manual-token-display');
        expect(missing.authPosture?.routes.provisionTokenRoute).toContain('setup action:"token"');
        expect(missing.authPosture?.routes.tokenProvisioningOwner).toContain('canonical token store');
        expect(missing.authPosture?.routes.tokenProvisioningSource).toContain('operator-tokens.json');

        const repair = await executeHarnessJson<{
          readonly mode: string;
          readonly setupItemId: string;
          readonly decision: {
            readonly id: string;
            readonly status: string;
            readonly effect: string;
            readonly modelRoute: string;
            readonly requiresConfirmation?: boolean;
          };
          readonly policy: { readonly confirmation: string };
        }>(fixture, { mode: 'setup_repair', setupItemId: 'connected-host-auth' });
        expect(repair.mode).toBe('setup_repair');
        expect(repair.setupItemId).toBe('connected-host-auth');
        expect(repair.decision.id).toBe('provision-connected-host-token');
        expect(repair.decision.status).toBe('confirmed-repair-available');
        expect(repair.decision.effect).toBe('confirmed-effect');
        expect(repair.decision.modelRoute).toContain('setup action:"token"');
        expect(repair.decision.requiresConfirmation).toBe(true);
        expect(repair.policy.confirmation).toContain('confirm:true');

        const unconfirmedProvision = await fixture.tool.execute({
          mode: 'provision_connected_host_token',
          setupItemId: 'connected-host-auth',
        });
        expect(unconfirmedProvision.success).toBe(false);
        expect(unconfirmedProvision.error).toContain('explicitUserRequest');

        const missingProvisionConfirm = await fixture.tool.execute({
          mode: 'provision_connected_host_token',
          setupItemId: 'connected-host-auth',
          explicitUserRequest: 'Provision connected-host auth for setup.',
        });
        expect(missingProvisionConfirm.success).toBe(false);
        expect(missingProvisionConfirm.error).toContain('confirm:true');

        const provisioned = await executeHarnessJson<{
          readonly status: string;
          readonly mode: string;
          readonly setupItemId: string;
          readonly token: {
            readonly path: string;
            readonly present: boolean;
            readonly usable: boolean;
            readonly fingerprint?: string | null;
            readonly rawValueReturned: boolean;
            readonly fileMode?: string | null;
          };
          readonly companionRecord?: { readonly peerId?: string; readonly surface?: string };
          readonly mutation?: {
            readonly performed?: boolean;
            readonly result?: string;
            readonly source?: string;
          };
          readonly routes: { readonly inspectStatus: string; readonly runSetupSmoke: string };
          readonly policy: { readonly secrets: string; readonly rotation: string };
        }>(fixture, {
          mode: 'provision_connected_host_token',
          setupItemId: 'connected-host-auth',
          confirm: true,
          explicitUserRequest: 'Provision connected-host auth for setup.',
        });

        expect(provisioned.status).toBe('created');
        expect(provisioned.mode).toBe('provision_connected_host_token');
        expect(provisioned.setupItemId).toBe('connected-host-auth');
        expect(provisioned.token.present).toBe(true);
        expect(provisioned.token.usable).toBe(true);
        expect(provisioned.token.rawValueReturned).toBe(false);
        expect(provisioned.token.path).toBe(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'));
        expect(provisioned.token.fileMode).toBe('0600');
        expect(provisioned.token.fingerprint).toHaveLength(12);
        expect(provisioned.companionRecord?.surface).toBe('goodvibes-agent');
        expect(provisioned.companionRecord?.peerId).toHaveLength(24);
        expect(provisioned.mutation?.performed).toBe(true);
        expect(provisioned.mutation?.source).toBe('getOrCreateCompanionToken');
        expect(provisioned.routes.inspectStatus).toContain('host action:"status"');
        expect(provisioned.routes.runSetupSmoke).toContain('setup action:"smoke"');
        expect(provisioned.policy.secrets).toContain('raw token is not returned');
        expect(provisioned.policy.rotation).toContain('preserves a valid existing token');
        const tokenRecordPath = join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json');
        expect(existsSync(tokenRecordPath)).toBe(true);
        const tokenRecord = JSON.parse(readFileSync(tokenRecordPath, 'utf-8')) as { readonly token?: string };
        expect(tokenRecord.token?.startsWith('gv_')).toBe(true);
        expect(JSON.stringify(provisioned)).not.toContain(tokenRecord.token ?? 'missing-generated-token');

        writeConnectedHostOperatorToken(fixture);
        const ready = await executeHarnessJson<{
          readonly status: string;
          readonly signals?: readonly string[];
          readonly authPosture?: {
            readonly operatorToken: {
              readonly present: boolean;
              readonly usable: boolean;
              readonly fingerprint?: string;
            };
          };
        }>(fixture, { mode: 'setup_item', setupItemId: 'connected-host-auth' });

        expect(ready.status).toBe('blocked');
        expect(ready.signals?.join('\n')).toContain('operator token: readable (not authority evidence)');
        expect(ready.authPosture?.operatorToken.present).toBe(true);
        expect(ready.authPosture?.operatorToken.usable).toBe(true);
        expect(ready.authPosture?.operatorToken.fingerprint).toHaveLength(12);
        expect(JSON.stringify(ready)).not.toContain('fixture-connected-host-token');
      } finally {
        fixture.cleanup();
      }
    });
  });

  test('covers first-run setup states for missing host reachable host and unconfigured model access', async () => {
    await withClearedEnv([...CONNECTED_HOST_AUTH_ENV_KEYS, ...PROVIDER_AUTH_ENV_KEYS], async () => {
      const missingHost = makeFixture();
      try {
        (missingHost.context.platform as unknown as {
          serviceRegistry: { getAll: () => Record<string, never>; inspect: () => Promise<null> };
        }).serviceRegistry = {
          getAll: () => {
            throw new Error('connected host registry unavailable');
          },
          inspect: async () => null,
        };
        const host = await executeHarnessJson<{
          readonly status: string;
          readonly signals?: readonly string[];
          readonly bootstrapPlan?: { readonly status: string };
          readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string };
          readonly repairCards?: readonly { readonly id: string; readonly state: string; readonly recommendation: string }[];
        }>(missingHost, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });

        expect(host.status).toBe('blocked');
        expect(host.signals?.join('\n')).toContain('connected host registry unavailable');
        expect(host.bootstrapPlan?.status).toBe('recommended');
        expect(host.serviceLifecycleDecision?.status).toBe('bootstrap-first');
        expect(host.serviceLifecycleDecision?.recommendedAction).toBe('inspect-service-posture');
        expect(host.repairCards?.find((card) => card.id === 'service-start')?.state).toBe('requires-live-host');
        expect(host.repairCards?.find((card) => card.id === 'service-start')?.recommendation).toBe('unavailable');

        const repair = await executeHarnessJson<{
          readonly setupItemId: string;
          readonly decision: { readonly id: string; readonly status: string; readonly effect: string; readonly modelRoute: string };
          readonly bootstrapPlan?: { readonly status: string; readonly steps: readonly { readonly id: string; readonly commands: readonly string[] }[] };
          readonly policy: { readonly boundary: string; readonly hostOwnership: string };
        }>(missingHost, { mode: 'setup_repair', setupItemId: 'connected-host-readiness', includeParameters: true });
        expect(repair.setupItemId).toBe('connected-host-readiness');
        expect(repair.decision.id).toBe('connected-host-bootstrap');
        expect(repair.decision.status).toBe('user-run-bootstrap');
        expect(repair.decision.effect).toBe('user-run');
        expect(repair.decision.modelRoute).toContain('setup action:"item"');
        expect(repair.bootstrapPlan?.status).toBe('recommended');
        expect(repair.bootstrapPlan?.steps.find((step) => step.id === 'start-goodvibes-host')?.commands).toContain('goodvibes service start');
        expect(repair.policy.boundary).toContain('never starts');
        expect(repair.policy.hostOwnership).toContain('user-run bootstrap');
      } finally {
        missingHost.cleanup();
      }

      const providerFixture = makeFixture();
      try {
        const posture = await executeHarnessJson<{
          readonly readinessPlan: readonly { readonly setupItemId: string; readonly status: string; readonly nextAction: string; readonly signals?: readonly string[] }[];
        }>(providerFixture, { mode: 'setup_posture', query: 'provider-access', includeParameters: true });
        const provider = posture.readinessPlan.find((item) => item.setupItemId === 'provider-access');
        expect(provider?.status).toBe('blocked');
        expect(provider?.nextAction).toContain('Choose a provider/model route');
        expect(provider?.signals ?? []).toEqual([]);
      } finally {
        providerFixture.cleanup();
      }

      await withTcpListener(async (port) => {
        const reachableHost = makeFixture({ controlPlaneEnabled: true, controlPlanePort: port });
        try {
          writeConnectedHostOperatorToken(reachableHost);
          const host = await executeHarnessJson<{
            readonly status: string;
            readonly serviceProbe?: { readonly status: string; readonly binding: string };
            readonly bootstrapPlan?: { readonly status: string };
            readonly serviceLifecycleDecision?: { readonly status: string; readonly recommendedAction: string; readonly modelRoute: string };
            readonly recommendedRepairCards?: readonly string[];
            readonly repairCards?: readonly { readonly id: string; readonly recommendation: string }[];
          }>(reachableHost, { mode: 'setup_item', setupItemId: 'connected-host-readiness' });

          expect(host.status).toBe('check');
          expect(host.serviceProbe?.status).toBe('reachable');
          expect(host.serviceProbe?.binding).toBe(`127.0.0.1:${port}`);
          expect(host.bootstrapPlan?.status).toBe('optional');
          expect(host.serviceLifecycleDecision?.status).toBe('no-lifecycle-action');
          expect(host.serviceLifecycleDecision?.recommendedAction).toBe('none');
          expect(host.serviceLifecycleDecision?.modelRoute).toContain('services.status');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-status');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-install');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-start');
          expect(host.recommendedRepairCards ?? []).not.toContain('service-restart');
          expect(host.repairCards?.find((card) => card.id === 'service-status')?.recommendation).toBe('not-needed');
          expect(host.repairCards?.find((card) => card.id === 'service-start')?.recommendation).toBe('not-needed');

          const repair = await executeHarnessJson<{
            readonly setupItemId: string;
            readonly decision: { readonly id: string; readonly status: string; readonly modelRoute: string; readonly requiresConfirmation?: boolean };
            readonly possibleConfirmedRepairs?: readonly unknown[];
          }>(reachableHost, { mode: 'setup_repair', setupItemId: 'connected-host-readiness' });
          expect(repair.setupItemId).toBe('connected-host-readiness');
          expect(repair.decision.id).toBe('connected-host-status');
          expect(repair.decision.status).toBe('ready');
          expect(repair.decision.modelRoute).toContain('host action:"status"');
          expect(repair.decision.requiresConfirmation).toBeUndefined();
          expect(repair.possibleConfirmedRepairs).toBeUndefined();

          const auth = await executeHarnessJson<{ readonly status: string }>(reachableHost, {
            mode: 'setup_item',
            setupItemId: 'connected-host-auth',
          });
          expect(auth.status).toBe('blocked');
        } finally {
          reachableHost.cleanup();
        }
      });
    });
  });

  test('exposes Personal Ops readiness without faking email or calendar connectors', async () => {
    const fixture = makeFixture();
    try {
      AgentNoteRegistry.fromShellPaths(fixture.paths).create({
        title: 'Follow-up queue',
        body: 'Track pending replies, reminders, and handoffs here.',
        tags: ['personal-ops'],
        source: 'agent',
        provenance: 'test',
      });

      const summary = await executeHarnessJson<{
        readonly personalOps?: { readonly lanes: number; readonly gap: number; readonly ready: number; readonly workflows: number; readonly setupWorkflows: number };
      }>(fixture, { mode: 'summary' });
      expect(summary.personalOps?.lanes).toBe(7);
      // Capability-advertisement honesty, after the mail and calendar services
      // became platform capability and the daemon started serving email.* and
      // calendar.*: the lanes no longer read as gaps, because the methods are
      // genuinely dispatchable now. They read PARTIAL rather than ready, the
      // routes exist, but no account is connected in this fixture, which is
      // the distinction that keeps this from claiming a working mailbox.
      expect(summary.personalOps?.gap).toBe(0);
      expect(summary.personalOps?.ready).toBeGreaterThan(0);
      expect(summary.personalOps?.workflows).toBeGreaterThan(0);
      // 4 needs-setup workflows. The writing-style-matched draft-reply workflow was
      // pulled from the advertised inbox lane (capability-honesty, 2026-07): it has no
      // sent-corpus reader and is recorded "not yet shipped", so it is no longer
      // advertised as a needs-setup workflow.
      expect(summary.personalOps?.setupWorkflows).toBe(0);

      const ops = await executeHarnessJson<{
        readonly workflowSummary: { readonly workflows: number; readonly needsSetup: number };
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly methodIds?: readonly string[];
          readonly workflows?: readonly {
            readonly id: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly inspectRoutes?: readonly string[];
            readonly prerequisites?: readonly string[];
            readonly runBoundary?: string;
          }[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly confirmationRequired?: boolean;
          }[];
        }[];
        readonly policy: string;
        readonly nextActions: readonly string[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });
      expect(ops.policy).toContain('Missing email/calendar connectors');
      expect(ops.nextActions.join('\n')).toContain('Inbox');
      // 4 needs-setup workflows after the unshipped writing-style draft-reply workflow
      // was pulled from the advertised inbox lane (capability-honesty, 2026-07).
      expect(ops.workflowSummary.needsSetup).toBe(0);

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      const notes = ops.lanes.find((lane) => lane.id === 'notes');
      const tasks = ops.lanes.find((lane) => lane.id === 'tasks');
      const reminders = ops.lanes.find((lane) => lane.id === 'reminders');
      const delivery = ops.lanes.find((lane) => lane.id === 'delivery');
      // The methods are served now, so the lane names them instead of
      // explaining why nothing can be called. It still does not claim a live
      // mailbox: the card tells the model to inspect the schema before acting,
      // which is the honest position when a route exists but no account does.
      expect(inbox?.status).toBe('partial');
      expect(inbox?.current).toContain('exposes email-like methods');
      expect(inbox?.methodIds).toEqual(expect.arrayContaining([
        'email.inbox.list', 'email.inbox.read', 'email.send', 'email.draft.create',
      ]));
      expect(inbox?.workflows?.[0]?.id).toBe('inbox-triage-briefing');
      expect(inbox?.workflows?.[0]?.status).toBe('ready');
      // The card now leads with a route that inspects a REAL method schema,
      // because there is one to inspect. Before the daemon served email.* the
      // best it could offer was a pointer back at the lane.
      expect(inbox?.workflows?.[0]?.inspectRoutes?.[0]).toContain('host action:"method"');
      expect(inbox?.workflows?.[0]?.inspectRoutes?.join('\n')).toContain('email.');
      expect(inbox?.workflows?.[0]?.prerequisites?.join('\n')).toContain('Inspect the exact connector or daemon method schema');
      expect(inbox?.workflows?.[0]?.runBoundary).toContain('confirmation');
      expect(calendar?.status).toBe('partial');
      expect(calendar?.methodIds).toEqual(expect.arrayContaining(['calendar.events.list', 'calendar.events.create']));
      expect(calendar?.workflows?.[0]?.id).toBe('calendar-agenda-briefing');
      expect(calendar?.workflows?.[0]?.status).toBe('ready');
      expect(notes?.status).toBe('ready');
      expect(notes?.current).toContain('1 note');
      expect(notes?.liveRecords?.[0]?.id).toBe('follow-up-queue');
      expect(notes?.liveRecords?.[0]?.label).toBe('Follow-up queue');
      expect(notes?.liveRecords?.[0]?.modelRoute).toContain('agent_local_registry');
      expect(tasks?.methodIds).toContain('tasks.list');
      expect(tasks?.workflows?.map((workflow) => workflow.id)).toEqual(expect.arrayContaining([
        'visible-work-plan-review',
        'connected-host-task-review',
      ]));
      expect(tasks?.workflows?.find((workflow) => workflow.id === 'connected-host-task-review')?.inspectRoutes?.join('\n')).toContain('tasks.list');
      const workPlanAdd = tasks?.liveRecords?.find((record) => record.id === 'workplan-add');
      const workPlanStatus = tasks?.liveRecords?.find((record) => record.id === 'workplan-status');
      expect(workPlanAdd?.modelRoute).toContain('action:"create"');
      expect(workPlanAdd?.confirmationRequired).toBe(false);
      expect(workPlanStatus?.modelRoute).toContain('action:"set_status"');
      expect(tasks?.liveRecords?.find((record) => record.id === 'host-tasks-list')?.effect).toBe('read-only');
      expect(tasks?.liveRecords?.find((record) => record.id === 'host-task-cancel')?.modelRoute).toContain('agent_operator_method');
      expect(reminders?.methodIds).toContain('automation.schedules.create');
      expect(reminders?.workflows?.map((workflow) => workflow.id)).toEqual(expect.arrayContaining([
        'confirmed-reminder-request',
        'connected-schedule-review',
      ]));
      expect(reminders?.workflows?.find((workflow) => workflow.id === 'connected-schedule-review')?.inspectRoutes?.join('\n')).toContain('schedule-list');
      const reminderCreate = reminders?.liveRecords?.find((record) => record.id === 'reminder-create');
      expect(reminderCreate?.modelRoute).toContain('schedule action:"remind"');
      expect(reminderCreate?.confirmationRequired).toBe(true);
      expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-list')?.effect).toBe('read-only');
      expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-edit')?.modelRoute).toContain('schedule action:"edit"');
      expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-pause')?.modelRoute).toContain('schedule action:"pause"');
      expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-resume')?.modelRoute).toContain('schedule action:"resume"');
      expect(reminders?.liveRecords?.find((record) => record.id === 'schedule-delete')?.modelRoute).toContain('schedule action:"delete"');
      expect(delivery?.liveRecords?.some((record) => record.modelRoute.includes('channels action:"channel"'))).toBe(true);

      const missingIntake = await executeHarnessJson<{
        readonly status: string;
        readonly preferred: {
          readonly id: string;
          readonly laneId: string;
          readonly status: string;
          readonly modelRoute: string;
          readonly inspectRoutes: readonly string[];
          readonly missingFields?: readonly string[];
          readonly safetyBoundary: string;
        };
        readonly laneRoute: string;
        readonly policy: string;
      }>(fixture, { mode: 'personal_ops_intake', query: 'Triage my unread inbox.' });
      expect(missingIntake.status).toBe('ready');
      expect(missingIntake.preferred.id).toBe('inbox-triage-briefing');
      expect(missingIntake.preferred.laneId).toBe('inbox');
      // Honest intake: the matched workflow now reports ready, because a
      // dispatchable email method genuinely exists (the daemon serves email.*).
      // The honesty this asserts moved down a level: 'ready' here means "there
      // is a route to inspect", and the card's own prerequisites still require
      // inspecting the schema before any mailbox is claimed.
      expect(missingIntake.preferred.status).toBe('ready');
      expect(missingIntake.preferred.modelRoute).toContain('host action:"methods"');
      // Every inspect route names a real, dispatchable method now. The
      // unified inbox verb (channels.inbox.list, it merges Slack/Discord/
      // email threads into one feed, see src/agent/unified-inbox.ts) sorts
      // first alphabetically among the matched email-lane methods, ahead of
      // email.inbox.list itself.
      expect(missingIntake.preferred.inspectRoutes.join('\n')).toContain('host action:"method" methodId:"channels.inbox.list"');
      // Nothing is missing to INSPECT any more: the method exists. The card
      // reports no missing field rather than naming one it no longer needs.
      expect(missingIntake.preferred.missingFields ?? []).toEqual([]);
      expect(missingIntake.preferred.safetyBoundary).toContain('confirmation');
      expect(missingIntake.laneRoute).toContain('laneId:"inbox"');
      expect(missingIntake.policy).toContain('read-only');

      const missingUsage = await executeHarnessJson<{
        readonly status: string;
        readonly usage: string;
        readonly examples: readonly string[];
      }>(fixture, { mode: 'personal_ops_intake' });
      expect(missingUsage.status).toBe('missing_request');
      expect(missingUsage.usage).toContain('personal_ops action:"intake"');
      expect(missingUsage.examples.join('\n')).toContain('Brief my calendar');

      const lane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly routes?: { readonly model: string };
      }>(fixture, { mode: 'personal_ops_lane', laneId: 'reminders' });
      expect(lane.id).toBe('reminders');
      expect(lane.status).toBe('ready');
      expect(lane.routes?.model).toContain('schedule action:"remind|create"');

      const notesLane = await executeHarnessJson<{
        readonly id: string;
        readonly liveRecords?: readonly { readonly id: string; readonly modelRoute: string }[];
      }>(fixture, { mode: 'personal_ops_lane', laneId: 'notes' });
      expect(notesLane.liveRecords?.[0]?.id).toBe('follow-up-queue');
      expect(notesLane.liveRecords?.[0]?.modelRoute).toContain('action:"get"');
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces saved Personal Ops review artifacts as durable lane queue records', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'saved-inbox-review.json',
      text: '{"reviewRecords":[]}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-review-cards',
        laneId: 'inbox',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
        reviewRecordCount: 2,
        reviewLabels: ['Escalation follow-up', 'Weekly planning'],
        reviewRecordIds: ['msg-escalation', 'msg-planning'],
        fullRawConnectorOutputStored: false,
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'saved-calendar-review.json',
      text: '{"reviewRecords":[]}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-review-cards',
        laneId: 'calendar',
        sourceTool: 'mcp:calendar:calendar.list_events',
        reviewRecordCount: 1,
        reviewLabels: ['Weekly sync'],
        reviewRecordIds: ['evt-weekly-sync'],
        fullRawConnectorOutputStored: false,
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const ops = await executeHarnessJson<{
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly artifactId?: string;
            readonly reviewRecordCount?: number;
            readonly reviewLabels?: readonly string[];
            readonly sourceTool?: string;
            readonly freshness?: {
              readonly status: string;
              readonly source: string;
              readonly sourceTool?: string;
              readonly refreshRoute?: string;
              readonly policy: string;
            };
            readonly followUpRoutes?: readonly {
              readonly id: string;
              readonly effect: string;
              readonly modelRoute: string;
              readonly requiresConfirmation: boolean;
              readonly policy: string;
            }[];
          }[];
        }[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const savedReview = inbox?.liveRecords?.find((record) => record.id === 'review-artifact:artifact-1');
      const savedThread = inbox?.liveRecords?.find((record) => record.id === 'review-thread:artifact-1:msg-escalation');
      expect(inbox?.status).toBe('partial');
      expect(inbox?.current).toContain('thread queue items');
      expect(inbox?.signals).toContain('1 saved inbox review artifact(s)');
      expect(inbox?.signals).toContain('2 saved inbox thread queue item(s)');
      expect(inbox?.signals).toContain('0 refreshable saved inbox queue item(s)');
      expect(savedThread?.label).toContain('Saved thread');
      expect(savedThread?.status).toBe('ready-for-draft');
      expect(savedThread?.capability).toBe('inbox-thread-review');
      expect(savedThread?.tags).toContain('draft-ready');
      expect(savedThread?.modelRoute).toContain('agent_artifacts show artifactId:"artifact-1"');
      expect(savedThread?.freshness).toMatchObject({
        status: 'provider-contract-missing',
        source: 'saved-review-artifact',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
      });
      expect(savedThread?.freshness?.refreshRoute).toBeUndefined();
      expect(savedThread?.freshness?.policy).toContain('matching read-only connector route');
      expect(savedThread?.followUpRoutes?.find((route) => route.id === 'draft-local-reply')?.requiresConfirmation).toBe(false);
      expect(savedThread?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.requiresConfirmation).toBe(true);
      expect(savedThread?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.policy).toContain('user confirms exact recipients and body');
      expect(savedReview?.label).toContain('Saved inbox review');
      expect(savedReview?.status).toBe('ready');
      expect(savedReview?.summary).toContain('2 normalized review cards');
      expect(savedReview?.summary).toContain('Escalation follow-up');
      expect(savedReview?.modelRoute).toContain('agent_artifacts show artifactId:"artifact-1"');
      expect(savedReview?.tags).toContain('saved-review');
      expect(savedReview?.effect).toBe('read-only');
      expect(savedReview?.capability).toBe('inbox-review-artifact');
      expect(savedReview?.artifactId).toBe('artifact-1');
      expect(savedReview?.reviewRecordCount).toBe(2);
      expect(savedReview?.reviewLabels).toEqual(['Escalation follow-up', 'Weekly planning']);
      expect(savedReview?.sourceTool).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(savedReview?.freshness?.status).toBe('provider-contract-missing');

      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      const savedEvent = calendar?.liveRecords?.find((record) => record.id === 'review-event:artifact-2:evt-weekly-sync');
      expect(calendar?.signals).toContain('1 saved calendar review artifact(s)');
      expect(calendar?.signals).toContain('1 saved calendar event queue item(s)');
      expect(calendar?.signals).toContain('0 refreshable saved calendar queue item(s)');
      expect(savedEvent?.label).toContain('Saved event');
      expect(savedEvent?.status).toBe('ready-for-reminder');
      expect(savedEvent?.capability).toBe('calendar-event-review');
      expect(savedEvent?.tags).toContain('reminder-ready');
      expect(savedEvent?.freshness?.status).toBe('provider-contract-missing');
      expect(savedEvent?.followUpRoutes?.find((route) => route.id === 'create-reminder-from-event')?.modelRoute).toContain('schedule action:"remind"');
      expect(savedEvent?.followUpRoutes?.find((route) => route.id === 'calendar-edit-boundary')?.requiresConfirmation).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces daemon-published Personal Ops inbox and calendar read-model records as current queues', async () => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.personalOps = {
        inboxThreads: {
          getSnapshot: () => ({
            threads: [{
              providerId: 'gmail',
              threadId: 'thread-secure-1',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.inbox-thread.v1',
              publicationGuarantee: 'daemon publishes thread snapshots after Gmail history sync token=gmail-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method gmail.threads.list', 'sourceTool personalOps.inboxThreads'],
              effectReceiptIds: ['gmail-reply-receipt-1', 'gmail-archive-receipt-1'],
              subject: 'Quarterly budget follow-up',
              status: 'unread',
              from: 'lead@example.test',
              labels: ['inbox', 'finance'],
              receivedAt: '2026-06-07T10:00:00Z',
              snippet: 'token=SECRET123 password=hunter2 Please review the budget.',
              readRoute: 'personal_ops_provider action:"read_thread" threadId:"thread-secure-1"',
              replyRoute: 'personal_ops_provider action:"reply_thread" threadId:"thread-secure-1" confirm:true',
              archiveRoute: 'personal_ops_provider action:"archive_thread" threadId:"thread-secure-1" confirm:true',
            }],
          }),
        },
        calendarEvents: {
          getSnapshot: () => ({
            events: [{
              providerId: 'caldav',
              eventId: 'evt-board-review',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.calendar-event.v1',
              publicationGuarantee: 'daemon publishes event snapshots after CalDAV sync credential=caldav-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method calendar.events.list', 'sourceTool personalOps.calendarEvents'],
              effectReceiptIds: ['caldav-edit-receipt-1', 'caldav-rsvp-receipt-1'],
              calendarId: 'primary',
              title: 'Board review',
              start: '2026-06-08T15:00:00Z',
              conflicts: [{ eventId: 'evt-overlap' }],
              preview: 'credential=calendar-secret Prep packet is ready.',
              editRoute: 'personal_ops_provider action:"edit_event" eventId:"evt-board-review" confirm:true',
              rsvpRoute: 'personal_ops_provider action:"rsvp_event" eventId:"evt-board-review" confirm:true',
            }],
          }),
        },
      };

      const ops = await executeHarnessJson<{
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly confirmationRequired?: boolean;
            readonly sourceTool?: string;
            readonly certification?: {
              readonly schemaStatus: string;
              readonly schemaVersion?: string;
              readonly publicationGuarantee?: string;
              readonly publisher?: string;
              readonly provenance?: readonly string[];
              readonly receiptIds?: readonly string[];
              readonly missingSignals: readonly string[];
              readonly policy: string;
            };
            readonly freshness?: {
              readonly status: string;
              readonly source: string;
              readonly sourceTool?: string;
              readonly refreshRoute?: string;
              readonly sampleInput?: Record<string, unknown>;
            };
            readonly followUpRoutes?: readonly {
              readonly id: string;
              readonly effect: string;
              readonly modelRoute: string;
              readonly requiresConfirmation: boolean;
              readonly policy: string;
            }[];
          }[];
        }[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      expect(inbox?.status).toBe('ready');
      expect(inbox?.current).toContain('Fresh provider-backed inbox thread records');
      expect(inbox?.next).toContain('published confirmed follow-up routes');
      expect(inbox?.signals).toContain('1 fresh provider-backed inbox thread record(s)');
      const thread = inbox?.liveRecords?.find((record) => record.capability === 'inbox-provider-thread');
      expect(thread?.label).toContain('Fresh thread');
      expect(thread?.effect).toBe('read-only');
      expect(thread?.confirmationRequired).toBe(false);
      expect(thread?.sourceTool).toBe('context.platform.readModels.personalOps.inboxThreads');
      expect(thread?.certification?.schemaStatus).toBe('certified');
      expect(thread?.certification?.schemaVersion).toBe('goodvibes.personal-ops.inbox-thread.v1');
      expect(thread?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(thread?.certification?.publicationGuarantee).not.toContain('gmail-pub-secret');
      expect(thread?.certification?.publisher).toBe('goodvibes-daemon');
      expect(thread?.certification?.provenance?.join('\n')).toContain('gmail.threads.list');
      expect(thread?.certification?.receiptIds).toEqual(['gmail-reply-receipt-1', 'gmail-archive-receipt-1']);
      expect(thread?.certification?.missingSignals).toEqual([]);
      expect(thread?.modelRoute).toContain('read_thread');
      expect(thread?.summary).toContain('token=<redacted>');
      expect(thread?.summary).not.toContain('SECRET123');
      expect(thread?.summary).not.toContain('hunter2');
      expect(thread?.tags).toContain('provider-backed');
      expect(thread?.freshness).toMatchObject({
        status: 'fresh-provider-route-ready',
        source: 'daemon-read-model',
        sourceTool: 'context.platform.readModels.personalOps.inboxThreads',
        sampleInput: { threadId: 'thread-secure-1' },
      });
      expect(thread?.freshness?.refreshRoute).toContain('read_thread');
      expect(thread?.followUpRoutes?.find((route) => route.id === 'inspect-provider-thread')?.requiresConfirmation).toBe(false);
      expect(thread?.followUpRoutes?.find((route) => route.id === 'reply-provider-thread')?.requiresConfirmation).toBe(true);
      expect(thread?.followUpRoutes?.find((route) => route.id === 'archive-provider-thread')?.policy).toContain('requires an explicit user request');

      expect(calendar?.status).toBe('ready');
      expect(calendar?.current).toContain('Fresh provider-backed calendar event records');
      expect(calendar?.signals).toContain('1 fresh provider-backed calendar event record(s)');
      const event = calendar?.liveRecords?.find((record) => record.capability === 'calendar-provider-event');
      expect(event?.label).toContain('Fresh event');
      expect(event?.status).toBe('conflict');
      expect(event?.certification?.schemaStatus).toBe('certified');
      expect(event?.certification?.publicationGuarantee).toContain('credential=<redacted>');
      expect(event?.certification?.publicationGuarantee).not.toContain('caldav-pub-secret');
      expect(event?.certification?.receiptIds).toEqual(['caldav-edit-receipt-1', 'caldav-rsvp-receipt-1']);
      expect(event?.certification?.missingSignals).toEqual([]);
      expect(event?.summary).toContain('1 conflict signal');
      expect(event?.summary).toContain('credential=<redacted>');
      expect(event?.summary).not.toContain('calendar-secret');
      expect(event?.modelRoute).toContain('laneId:"calendar"');
      expect(event?.freshness).toMatchObject({
        status: 'fresh-provider-record-current',
        source: 'daemon-read-model',
        sourceTool: 'context.platform.readModels.personalOps.calendarEvents',
        sampleInput: { eventId: 'evt-board-review', calendarId: 'primary' },
      });
      expect(event?.freshness?.refreshRoute).toBeUndefined();
      expect(event?.followUpRoutes?.find((route) => route.id === 'inspect-provider-event')?.requiresConfirmation).toBe(false);
      expect(event?.followUpRoutes?.find((route) => route.id === 'edit-provider-event')?.requiresConfirmation).toBe(true);
      expect(event?.followUpRoutes?.find((route) => route.id === 'rsvp-provider-event')?.requiresConfirmation).toBe(true);

      const queue = await executeHarnessJson<{
        readonly status: string;
        readonly summary: { readonly inbox: number; readonly calendar: number; readonly freshProviderReads: number; readonly confirmedFollowUps: number };
        readonly queue: readonly {
          readonly laneId: string;
          readonly type: string;
          readonly capability?: string;
          readonly certification?: { readonly schemaStatus: string; readonly missingSignals: readonly string[] };
          readonly freshness?: { readonly status: string; readonly source: string; readonly refreshRoute?: string };
          readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean }[];
        }[];
        readonly nextActions: readonly string[];
      }>(fixture, { mode: 'personal_ops_queue', includeParameters: true });
      expect(queue.status).toBe('ready');
      expect(queue.summary.inbox).toBe(1);
      expect(queue.summary.calendar).toBe(1);
      expect(queue.summary.freshProviderReads).toBe(2);
      expect(queue.summary.confirmedFollowUps).toBeGreaterThanOrEqual(4);
      expect(queue.queue.find((record) => record.capability === 'inbox-provider-thread')?.type).toBe('fresh-provider-read');
      expect(queue.queue.find((record) => record.capability === 'calendar-provider-event')?.type).toBe('fresh-provider-record');
      expect(queue.queue.find((record) => record.capability === 'inbox-provider-thread')?.certification?.schemaStatus).toBe('certified');
      expect(queue.queue.find((record) => record.capability === 'calendar-provider-event')?.certification?.missingSignals).toEqual([]);
      expect(queue.nextActions.join('\n')).toContain('Inspect one current provider-backed queue record');

      const briefing = await executeHarnessJson<{
        readonly steps: readonly {
          readonly id: string;
          readonly status: string;
          readonly next: string;
          readonly sourceCounts: { readonly freshProviderReads?: number };
        }[];
        readonly missingContracts?: readonly string[];
      }>(fixture, { mode: 'personal_ops_briefing', includeParameters: true });
      const inboxBrief = briefing.steps.find((step) => step.id === 'inbox');
      const calendarBrief = briefing.steps.find((step) => step.id === 'calendar');
      expect(inboxBrief?.status).toBe('ready');
      expect(calendarBrief?.status).toBe('ready');
      expect(inboxBrief?.sourceCounts.freshProviderReads).toBe(1);
      expect(calendarBrief?.sourceCounts.freshProviderReads).toBe(1);
      expect(inboxBrief?.next).toContain('Inspect one current provider-backed record');
      expect(briefing.missingContracts ?? []).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces daemon-published Personal Ops task and reminder records as current provider queues', async () => {
    const fixture = makeFixture();
    try {
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      readModels.personalOps = {
        tasks: {
          getSnapshot: () => ({
            tasks: [{
              providerId: 'todoist',
              taskId: 'task-budget-review',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.task.v1',
              publicationGuarantee: 'daemon publishes task snapshots after provider sync token=task-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method tasks.list', 'sourceTool personalOps.tasks'],
              effectReceiptIds: ['todoist-update-receipt-1', 'todoist-complete-receipt-1'],
              title: 'Review budget task',
              status: 'active',
              project: 'Finance',
              dueAt: '2026-06-09T14:00:00Z',
              priority: 'high',
              assignee: 'owner@example.test',
              labels: ['finance', 'review'],
              preview: 'token=TASKSECRET Check the latest budget.',
              readRoute: 'personal_ops_provider action:"read_task" taskId:"task-budget-review"',
              updateRoute: 'personal_ops_provider action:"update_task" taskId:"task-budget-review" confirm:true',
              completeRoute: 'personal_ops_provider action:"complete_task" taskId:"task-budget-review" confirm:true',
            }],
          }),
        },
        reminders: {
          getSnapshot: () => ({
            reminders: [{
              providerId: 'caldav',
              reminderId: 'reminder-report',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.personal-ops.reminder.v1',
              publicationGuarantee: 'daemon publishes reminder snapshots after schedule sync password=reminder-pub-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method reminders.list', 'sourceTool personalOps.reminders'],
              effectReceiptIds: ['reminder-edit-receipt-1', 'reminder-snooze-receipt-1', 'reminder-delete-receipt-1'],
              title: 'Send report reminder',
              status: 'scheduled',
              remindAt: '2026-06-10T09:00:00Z',
              cadence: 'once',
              deliveryTarget: 'email',
              preview: 'password=REMINDERSECRET Draft is ready.',
              editRoute: 'personal_ops_provider action:"edit_reminder" reminderId:"reminder-report" confirm:true',
              snoozeRoute: 'personal_ops_provider action:"snooze_reminder" reminderId:"reminder-report" confirm:true',
              deleteRoute: 'personal_ops_provider action:"delete_reminder" reminderId:"reminder-report" confirm:true',
            }],
          }),
        },
      };

      const tasksLane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly current: string;
        readonly next: string;
        readonly signals: readonly string[];
        readonly liveRecords?: readonly {
          readonly id: string;
          readonly label: string;
          readonly status: string;
          readonly summary: string;
          readonly modelRoute: string;
          readonly tags?: readonly string[];
          readonly effect?: string;
          readonly capability?: string;
          readonly confirmationRequired?: boolean;
          readonly sourceTool?: string;
          readonly certification?: {
            readonly schemaStatus: string;
            readonly schemaVersion?: string;
            readonly publicationGuarantee?: string;
            readonly publisher?: string;
            readonly provenance?: readonly string[];
            readonly receiptIds?: readonly string[];
            readonly missingSignals: readonly string[];
          };
          readonly freshness?: {
            readonly status: string;
            readonly source: string;
            readonly sourceTool?: string;
            readonly refreshRoute?: string;
            readonly sampleInput?: Record<string, unknown>;
          };
          readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string; readonly policy: string }[];
        }[];
      }>(fixture, { mode: 'personal_ops_lane', laneId: 'tasks', includeParameters: true });
      expect(tasksLane.status).toBe('ready');
      expect(tasksLane.current).toContain('Fresh provider-backed task records');
      expect(tasksLane.next).toContain('published confirmed follow-up route');
      expect(tasksLane.signals).toContain('1 fresh provider-backed task record(s)');
      const taskRecord = tasksLane.liveRecords?.find((record) => record.capability === 'task-provider-record');
      expect(taskRecord?.label).toContain('Fresh task');
      expect(taskRecord?.effect).toBe('read-only');
      expect(taskRecord?.confirmationRequired).toBe(false);
      expect(taskRecord?.sourceTool).toBe('context.platform.readModels.personalOps.tasks');
      expect(taskRecord?.certification?.schemaStatus).toBe('certified');
      expect(taskRecord?.certification?.schemaVersion).toBe('goodvibes.personal-ops.task.v1');
      expect(taskRecord?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(taskRecord?.certification?.publicationGuarantee).not.toContain('task-pub-secret');
      expect(taskRecord?.certification?.publisher).toBe('goodvibes-daemon');
      expect(taskRecord?.certification?.provenance?.join('\n')).toContain('tasks.list');
      expect(taskRecord?.certification?.receiptIds).toEqual(['todoist-update-receipt-1', 'todoist-complete-receipt-1']);
      expect(taskRecord?.certification?.missingSignals).toEqual([]);
      expect(taskRecord?.modelRoute).toContain('read_task');
      expect(taskRecord?.summary).toContain('token=<redacted>');
      expect(taskRecord?.summary).not.toContain('TASKSECRET');
      expect(taskRecord?.tags).toContain('provider-backed');
      expect(taskRecord?.freshness).toMatchObject({
        status: 'fresh-provider-route-ready',
        source: 'daemon-read-model',
        sourceTool: 'context.platform.readModels.personalOps.tasks',
        sampleInput: { taskId: 'task-budget-review' },
      });
      expect(taskRecord?.freshness?.refreshRoute).toContain('read_task');
      expect(taskRecord?.followUpRoutes?.find((route) => route.id === 'update-provider-task')?.requiresConfirmation).toBe(true);
      expect(taskRecord?.followUpRoutes?.find((route) => route.id === 'complete-provider-task')?.policy).toContain('requires explicit confirmation');
      expect(tasksLane.liveRecords?.find((record) => record.id === 'workplan-list')).toBeDefined();

      const remindersLane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly current: string;
        readonly next: string;
        readonly signals: readonly string[];
        readonly liveRecords?: readonly {
          readonly id: string;
          readonly label: string;
          readonly summary: string;
          readonly modelRoute: string;
          readonly tags?: readonly string[];
          readonly effect?: string;
          readonly capability?: string;
          readonly confirmationRequired?: boolean;
          readonly sourceTool?: string;
          readonly certification?: {
            readonly schemaStatus: string;
            readonly schemaVersion?: string;
            readonly publicationGuarantee?: string;
            readonly publisher?: string;
            readonly provenance?: readonly string[];
            readonly receiptIds?: readonly string[];
            readonly missingSignals: readonly string[];
          };
          readonly freshness?: { readonly status: string; readonly source: string; readonly sourceTool?: string; readonly refreshRoute?: string; readonly sampleInput?: Record<string, unknown> };
          readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string; readonly policy: string }[];
        }[];
      }>(fixture, { mode: 'personal_ops_lane', laneId: 'reminders', includeParameters: true });
      expect(remindersLane.status).toBe('ready');
      expect(remindersLane.current).toContain('Fresh provider-backed reminder records');
      expect(remindersLane.next).toContain('published confirmed follow-up route');
      expect(remindersLane.signals).toContain('1 fresh provider-backed reminder record(s)');
      const reminderRecord = remindersLane.liveRecords?.find((record) => record.capability === 'reminder-provider-record');
      expect(reminderRecord?.label).toContain('Fresh reminder');
      expect(reminderRecord?.effect).toBe('read-only');
      expect(reminderRecord?.confirmationRequired).toBe(false);
      expect(reminderRecord?.sourceTool).toBe('context.platform.readModels.personalOps.reminders');
      expect(reminderRecord?.certification?.schemaStatus).toBe('certified');
      expect(reminderRecord?.certification?.schemaVersion).toBe('goodvibes.personal-ops.reminder.v1');
      expect(reminderRecord?.certification?.publicationGuarantee).toContain('password=<redacted>');
      expect(reminderRecord?.certification?.publicationGuarantee).not.toContain('reminder-pub-secret');
      expect(reminderRecord?.certification?.publisher).toBe('goodvibes-daemon');
      expect(reminderRecord?.certification?.provenance?.join('\n')).toContain('reminders.list');
      expect(reminderRecord?.certification?.receiptIds).toEqual(['reminder-edit-receipt-1', 'reminder-snooze-receipt-1', 'reminder-delete-receipt-1']);
      expect(reminderRecord?.certification?.missingSignals).toEqual([]);
      expect(reminderRecord?.modelRoute).toContain('laneId:"reminders"');
      expect(reminderRecord?.summary).toContain('password=<redacted>');
      expect(reminderRecord?.summary).not.toContain('REMINDERSECRET');
      expect(reminderRecord?.freshness).toMatchObject({
        status: 'fresh-provider-record-current',
        source: 'daemon-read-model',
        sourceTool: 'context.platform.readModels.personalOps.reminders',
        sampleInput: { reminderId: 'reminder-report' },
      });
      expect(reminderRecord?.freshness?.refreshRoute).toBeUndefined();
      expect(reminderRecord?.followUpRoutes?.find((route) => route.id === 'edit-provider-reminder')?.requiresConfirmation).toBe(true);
      expect(reminderRecord?.followUpRoutes?.find((route) => route.id === 'snooze-provider-reminder')?.modelRoute).toContain('snooze_reminder');
      expect(reminderRecord?.followUpRoutes?.find((route) => route.id === 'delete-provider-reminder')?.policy).toContain('explicit confirmation');
      expect(remindersLane.liveRecords?.find((record) => record.id === 'reminder-create')).toBeDefined();

      const briefing = await executeHarnessJson<{
        readonly steps: readonly { readonly id: string; readonly status: string; readonly evidence: readonly string[]; readonly sourceCounts: { readonly freshProviderReads?: number } }[];
      }>(fixture, { mode: 'personal_ops_briefing', includeParameters: true });
      const taskBrief = briefing.steps.find((step) => step.id === 'tasks');
      const reminderBrief = briefing.steps.find((step) => step.id === 'reminders');
      expect(taskBrief?.status).toBe('ready');
      expect(reminderBrief?.status).toBe('ready');
      expect(taskBrief?.evidence.join('\n')).toContain('1 fresh provider-backed task record(s)');
      expect(reminderBrief?.evidence.join('\n')).toContain('1 fresh provider-backed reminder record(s)');
      expect(taskBrief?.sourceCounts.freshProviderReads).toBe(1);
      expect(reminderBrief?.sourceCounts.freshProviderReads).toBe(1);
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces Personal Ops provider-effect receipts as read-only lane evidence', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'gmail-send-receipt.json',
      text: '{"status":"succeeded"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-provider-effect-receipt',
        laneId: 'inbox',
        providerId: 'gmail',
        operation: 'send-reply',
        status: 'succeeded',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores provider-effect receipts after confirmed calls token=gmail-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method gmail.send_reply', 'sourceTool mcp:gmail:gmail.send_reply'],
        receiptId: 'gmail-send-1',
        threadId: 'thread-secret-token-123',
        sourceTool: 'mcp:gmail:gmail.send_reply',
        createdAt: '2026-06-08T13:00:00.000Z',
        redaction: 'metadata-only',
        nextRoute: 'personal_ops action:"lane" laneId:"inbox" includeParameters:true',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'calendar-rsvp-receipt.json',
      text: '{"status":"failed"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'connected-host-personal-ops-effect-receipt',
        laneId: 'calendar',
        providerId: 'caldav',
        operation: 'rsvp',
        status: 'failed',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores provider-effect receipts after confirmed calls credential=caldav-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method calendar.rsvp', 'sourceTool mcp:calendar:calendar.rsvp'],
        receiptId: 'caldav-rsvp-1',
        eventId: 'evt-board-review',
        sourceTool: 'mcp:calendar:calendar.rsvp',
        failureReason: 'Provider rejected stale event tag',
        createdAt: '2026-06-08T13:05:00.000Z',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'task-complete-receipt.json',
      text: '{"status":"succeeded"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'personal-ops-provider-effect-receipt',
        laneId: 'tasks',
        providerId: 'todoist',
        operation: 'complete',
        status: 'succeeded',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores task receipts after confirmed calls secret=task-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method tasks.complete', 'sourceTool mcp:tasks:tasks.complete'],
        receiptId: 'todoist-complete-1',
        taskId: 'task-budget-review',
        sourceTool: 'mcp:tasks:tasks.complete',
        createdAt: '2026-06-08T13:08:00.000Z',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'reminder-snooze-receipt.json',
      text: '{"status":"succeeded"}\n',
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: {
        purpose: 'connected-host-personal-ops-effect-receipt',
        laneId: 'reminders',
        providerId: 'caldav',
        operation: 'snooze',
        status: 'succeeded',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.personal-ops.effect-receipt.v1',
        publicationGuarantee: 'daemon stores reminder receipts after confirmed calls password=reminder-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method reminders.snooze', 'sourceTool mcp:reminders:reminders.snooze'],
        receiptId: 'reminder-snooze-1',
        reminderId: 'reminder-report',
        sourceTool: 'mcp:reminders:reminders.snooze',
        createdAt: '2026-06-08T13:09:00.000Z',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const ops = await executeHarnessJson<{
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly next: string;
          readonly signals: readonly string[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly summary: string;
            readonly modelRoute: string;
            readonly tags?: readonly string[];
            readonly effect?: string;
            readonly capability?: string;
            readonly artifactId?: string;
            readonly sourceTool?: string;
            readonly confirmationRequired?: boolean;
            readonly certification?: {
              readonly schemaStatus: string;
              readonly schemaVersion?: string;
              readonly publicationGuarantee?: string;
              readonly publisher?: string;
              readonly provenance?: readonly string[];
              readonly receiptId?: string;
              readonly missingSignals: readonly string[];
            };
            readonly followUpRoutes?: readonly {
              readonly id: string;
              readonly effect: string;
              readonly modelRoute: string;
              readonly requiresConfirmation: boolean;
              readonly policy: string;
            }[];
          }[];
        }[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const inboxReceipt = inbox?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-1');
      expect(inbox?.status).toBe('partial');
      expect(inbox?.current).toContain('provider-effect receipts');
      expect(inbox?.signals).toContain('1 saved inbox provider-effect receipt(s)');
      expect(inboxReceipt?.label).toContain('Inbox effect receipt');
      expect(inboxReceipt?.status).toBe('succeeded');
      expect(inboxReceipt?.summary).toContain('send-reply succeeded');
      expect(inboxReceipt?.summary).toContain('Provider gmail');
      expect(inboxReceipt?.summary).toContain('Subject thread-secret-token-123');
      expect(inboxReceipt?.summary).toContain('Redaction metadata-only');
      expect(inboxReceipt?.modelRoute).toBe('agent_artifacts show artifactId:"artifact-1" includeContent:false');
      expect(inboxReceipt?.tags).toContain('provider-effect-receipt');
      expect(inboxReceipt?.tags).toContain('send-reply');
      expect(inboxReceipt?.effect).toBe('read-only');
      expect(inboxReceipt?.capability).toBe('inbox-effect-receipt');
      expect(inboxReceipt?.artifactId).toBe('artifact-1');
      expect(inboxReceipt?.sourceTool).toBe('mcp:gmail:gmail.send_reply');
      expect(inboxReceipt?.confirmationRequired).toBe(false);
      expect(inboxReceipt?.certification?.schemaStatus).toBe('certified');
      expect(inboxReceipt?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(inboxReceipt?.certification?.publicationGuarantee).not.toContain('gmail-receipt-secret');
      expect(inboxReceipt?.certification?.receiptId).toBe('gmail-send-1');
      expect(inboxReceipt?.certification?.missingSignals).toEqual([]);
      expect(inboxReceipt?.followUpRoutes?.find((route) => route.id === 'inspect-effect-receipt')?.requiresConfirmation).toBe(false);
      expect(inboxReceipt?.followUpRoutes?.find((route) => route.id === 'continue-provider-lane')?.modelRoute).toContain('laneId:"inbox"');

      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      const calendarReceipt = calendar?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-2');
      expect(calendar?.status).toBe('partial');
      expect(calendar?.current).toContain('provider-effect receipts');
      expect(calendar?.signals).toContain('1 saved calendar provider-effect receipt(s)');
      expect(calendarReceipt?.label).toContain('Calendar effect receipt');
      expect(calendarReceipt?.status).toBe('failed');
      expect(calendarReceipt?.summary).toContain('rsvp failed');
      expect(calendarReceipt?.summary).toContain('Provider caldav');
      expect(calendarReceipt?.summary).toContain('Subject evt-board-review');
      expect(calendarReceipt?.summary).toContain('Failure Provider rejected stale event tag');
      expect(calendarReceipt?.modelRoute).toBe('agent_artifacts show artifactId:"artifact-2" includeContent:false');
      expect(calendarReceipt?.tags).toContain('calendar-effect');
      expect(calendarReceipt?.tags).toContain('rsvp');
      expect(calendarReceipt?.effect).toBe('read-only');
      expect(calendarReceipt?.capability).toBe('calendar-effect-receipt');
      expect(calendarReceipt?.artifactId).toBe('artifact-2');
      expect(calendarReceipt?.sourceTool).toBe('mcp:calendar:calendar.rsvp');
      expect(calendarReceipt?.certification?.schemaStatus).toBe('certified');
      expect(calendarReceipt?.certification?.publicationGuarantee).toContain('credential=<redacted>');
      expect(calendarReceipt?.certification?.publicationGuarantee).not.toContain('caldav-receipt-secret');
      expect(calendarReceipt?.certification?.receiptId).toBe('caldav-rsvp-1');
      expect(calendarReceipt?.certification?.missingSignals).toEqual([]);
      expect(calendarReceipt?.followUpRoutes?.find((route) => route.id === 'continue-provider-lane')?.modelRoute).toContain('laneId:"calendar"');

      const tasks = ops.lanes.find((lane) => lane.id === 'tasks');
      const taskReceipt = tasks?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-3');
      expect(tasks?.signals).toContain('1 saved task provider-effect receipt(s)');
      expect(taskReceipt?.label).toContain('Task effect receipt');
      expect(taskReceipt?.summary).toContain('complete succeeded');
      expect(taskReceipt?.capability).toBe('task-effect-receipt');
      expect(taskReceipt?.tags).toContain('tasks-effect');
      expect(taskReceipt?.sourceTool).toBe('mcp:tasks:tasks.complete');
      expect(taskReceipt?.certification?.schemaStatus).toBe('certified');
      expect(taskReceipt?.certification?.publicationGuarantee).toContain('secret=<redacted>');
      expect(taskReceipt?.certification?.receiptId).toBe('todoist-complete-1');
      expect(taskReceipt?.certification?.missingSignals).toEqual([]);

      const reminders = ops.lanes.find((lane) => lane.id === 'reminders');
      const reminderReceipt = reminders?.liveRecords?.find((record) => record.id === 'provider-effect-receipt:artifact-4');
      expect(reminders?.signals).toContain('1 saved reminder provider-effect receipt(s)');
      expect(reminderReceipt?.label).toContain('Reminder effect receipt');
      expect(reminderReceipt?.summary).toContain('snooze succeeded');
      expect(reminderReceipt?.capability).toBe('reminder-effect-receipt');
      expect(reminderReceipt?.tags).toContain('reminders-effect');
      expect(reminderReceipt?.sourceTool).toBe('mcp:reminders:reminders.snooze');
      expect(reminderReceipt?.certification?.schemaStatus).toBe('certified');
      expect(reminderReceipt?.certification?.publicationGuarantee).toContain('password=<redacted>');
      expect(reminderReceipt?.certification?.receiptId).toBe('reminder-snooze-1');
      expect(reminderReceipt?.certification?.missingSignals).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces Agent memory, vector recall, and external memory-provider posture', async () => {
    const fixture = makeFixture();
    try {
      attachMemoryApi(fixture);
      const summary = await executeHarnessJson<{
        readonly memoryPosture?: {
          readonly status?: string;
          readonly localMemories?: number;
          readonly promptActive?: number;
          readonly vector?: string;
          readonly embeddingProviders?: number;
          readonly externalProviderRecordsPublished?: boolean;
          readonly externalProviderSetupGuideStatus?: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryPosture?.status).toBe('ready');
      expect(summary.memoryPosture?.localMemories).toBe(1);
      expect(summary.memoryPosture?.promptActive).toBe(1);
      expect(summary.memoryPosture?.vector).toBe('ready');
      expect(summary.memoryPosture?.embeddingProviders).toBe(1);
      expect(summary.memoryPosture?.externalProviderRecordsPublished).toBe(false);
      expect(summary.memoryPosture?.externalProviderSetupGuideStatus).toBe('contract-needed');

      const posture = await executeHarnessJson<{
        readonly status: string;
        readonly localMemory: {
          readonly total: number;
          readonly promptActive: number;
          readonly routes: { readonly curator: string };
        };
        readonly vector: {
          readonly status: string;
          readonly indexedRecords: number;
          readonly rebuildRoute: string;
        };
        readonly embeddings: { readonly activeProviderId: string; readonly syncProviders: readonly string[] };
        readonly providers: readonly {
          readonly id: string;
          readonly kind: string;
          readonly status: string;
          readonly active?: boolean;
          readonly setupRoute?: string;
        }[];
        readonly externalMemory: {
          readonly status: string;
          readonly providerRecordsPublished: boolean;
          readonly setupGuideStatus?: string;
          readonly checkedProviders: readonly string[];
          readonly requiredHostContracts?: readonly string[];
          readonly contractChecklist?: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
          readonly receiptContract?: { readonly status: string; readonly requiredFields: readonly string[] };
          readonly nextRoutes?: readonly { readonly id: string; readonly modelRoute: string; readonly effect: string }[];
          readonly providerLookup?: string;
        };
        readonly nextActions: readonly string[];
        readonly policy: string;
      }>(fixture, { mode: 'memory_posture', includeParameters: true, limit: 20 });
      expect(posture.status).toBe('ready');
      expect(posture.localMemory.total).toBe(1);
      expect(posture.localMemory.promptActive).toBe(1);
      expect(posture.localMemory.routes.curator).toBe('memory action:"curator"');
      expect(posture.vector.status).toBe('ready');
      expect(posture.vector.indexedRecords).toBe(1);
      expect(posture.vector.rebuildRoute).toContain('memory-vector-rebuild');
      expect(posture.embeddings.activeProviderId).toBe('hashed-local');
      expect(posture.embeddings.syncProviders).toContain('hashed-local');
      expect(posture.providers.find((provider) => provider.id === 'hashed-local')?.active).toBe(true);
      expect(posture.providers.find((provider) => provider.id === 'honcho')?.status).toBe('not-published');
      expect(posture.providers.find((provider) => provider.id === 'mem0')?.setupRoute).toContain('host action:"capability"');
      expect(posture.externalMemory.status).toBe('not-published');
      expect(posture.externalMemory.providerRecordsPublished).toBe(false);
      expect(posture.externalMemory.setupGuideStatus).toBe('contract-needed');
      expect(posture.externalMemory.checkedProviders).toContain('supermemory');
      expect(posture.externalMemory.requiredHostContracts?.join('\n')).toContain('Credential reference');
      expect(posture.externalMemory.contractChecklist?.map((entry) => entry.id)).toContain('sync-receipts');
      expect(posture.externalMemory.contractChecklist?.find((entry) => entry.id === 'status-record')?.inspectRoute).toContain('host action:"capability"');
      expect(posture.externalMemory.receiptContract?.requiredFields).toContain('receiptId');
      expect(posture.externalMemory.receiptContract?.requiredFields).toContain('nextRoute');
      expect(posture.externalMemory.nextRoutes?.find((route) => route.id === 'inspect-one-provider')?.modelRoute).toContain('memory action:"provider"');
      expect(posture.externalMemory.providerLookup).toContain('memory action:"provider"');
      expect(posture.nextActions.join('\n')).toContain('memory action:"provider"');
      expect(posture.policy).toContain('read-only');

      const provider = await executeHarnessJson<{
        readonly id: string;
        readonly kind: string;
        readonly status: string;
        readonly active?: boolean;
        readonly dimensions?: number;
      }>(fixture, { mode: 'memory_provider', providerId: 'hashed-local' });
      expect(provider.id).toBe('hashed-local');
      expect(provider.kind).toBe('embedding');
      expect(provider.status).toBe('healthy');
      expect(provider.active).toBe(true);
      expect(provider.dimensions).toBe(384);

      const external = await executeHarnessJson<{
        readonly id: string;
        readonly kind: string;
        readonly status: string;
        readonly summary: string;
        readonly setupGuide?: {
          readonly status: string;
          readonly userOutcome: string;
          readonly safeFirstStep: string;
          readonly inspectRoutes: readonly string[];
          readonly nextRoutes: readonly { readonly id: string; readonly modelRoute: string; readonly effect: string }[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string; readonly requiredFor: string }[];
          readonly receiptContract: { readonly status: string; readonly appliesTo: readonly string[]; readonly requiredFields: readonly string[] };
          readonly requiredHostContracts: readonly string[];
          readonly credentialPolicy: string;
          readonly confirmationPolicy: string;
        };
      }>(fixture, { mode: 'memory_provider', providerId: 'supermemory' });
      expect(external.id).toBe('supermemory');
      expect(external.kind).toBe('external-memory');
      expect(external.status).toBe('not-published');
      expect(external.summary).toContain('not published');
      expect(external.setupGuide).toMatchObject({
        status: 'contract-needed',
      });
      expect(external.setupGuide?.userOutcome).toContain('Supermemory');
      expect(external.setupGuide?.safeFirstStep).toContain('Agent-local memory');
      expect(external.setupGuide?.inspectRoutes.join('\n')).toContain('host action:"capability"');
      expect(external.setupGuide?.nextRoutes.find((route) => route.id === 'inspect-host-capability')?.effect).toBe('read-only');
      expect(external.setupGuide?.contractChecklist.find((entry) => entry.id === 'confirmed-write-upsert')?.requiredFor).toContain('explicit user request');
      expect(external.setupGuide?.receiptContract.appliesTo).toContain('sync');
      expect(external.setupGuide?.receiptContract.requiredFields).toContain('failureReason');
      expect(external.setupGuide?.requiredHostContracts.join('\n')).toContain('Prompt-injection eligibility policy');
      expect(external.setupGuide?.credentialPolicy).toContain('raw API keys');
      expect(external.setupGuide?.confirmationPolicy).toContain('durable receipts');

      const actions = await executeHarnessJson<{
        readonly actions: readonly { readonly id: string; readonly modelRoute?: string }[];
      }>(fixture, { mode: 'workspace_actions', query: 'memory posture' });
      expect(actions.actions.find((entry) => entry.id === 'memory-posture')?.modelRoute).toBe('memory action:"status"');
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces supervised semantic memory refinement tasks and confirmed bounded runs', async () => {
    const fixture = makeFixture();
    try {
      const now = Date.now();
      const refinementTasks = [{
        id: 'kref-gap-1',
        spaceId: 'agent',
        subjectKind: 'node',
        subjectId: 'node-1',
        subjectTitle: 'Agent memory export',
        subjectType: 'memory',
        gapId: 'sem-gap-1',
        state: 'blocked',
        priority: 'high',
        trigger: 'manual',
        budget: { maxSearches: 5 },
        attemptCount: 1,
        blockedReason: 'No semantic gap repairer is configured.',
        acceptedSourceIds: ['src-1'],
        ingestedSourceIds: ['src-2'],
        promotedFactCount: 1,
        sourceAssessments: [{
          url: 'https://example.test/source',
          title: 'Source',
          accepted: true,
          confidence: 91,
          reasons: ['domain matched', 'fresh source'],
        }],
        trace: [
          { at: now - 1_000, state: 'detected', message: 'Gap was detected.' },
          { at: now, state: 'blocked', message: 'No semantic gap repairer is configured.' },
        ],
        metadata: { gapTitle: 'Which source proves memory sync?' },
        createdAt: now - 2_000,
        updatedAt: now,
      }];
      const runRequests: Record<string, unknown>[] = [];
      (fixture.context.extensions as unknown as { agentKnowledgeService: unknown }).agentKnowledgeService = {
        listRefinementTasks: () => refinementTasks,
        getRefinementTask: (id: string) => refinementTasks.find((task) => task.id === id) ?? null,
        listJobs: () => [{
          id: 'knowledge-semantic-self-improvement',
          kind: 'semantic-self-improvement',
          title: 'Semantic Self-Improvement',
          description: 'Classify and repair semantic Knowledge gaps.',
          defaultMode: 'background',
          metadata: { category: 'semantic' },
        }],
        listJobRuns: () => [{
          id: 'job-run-1',
          jobId: 'knowledge-semantic-self-improvement',
          status: 'completed',
          mode: 'inline',
          requestedAt: now - 500,
          completedAt: now - 100,
          result: { processedGaps: 1 },
          metadata: {},
          createdAt: now - 500,
          updatedAt: now - 100,
        }],
        runRefinement: async (input: Record<string, unknown>) => {
          runRequests.push(input);
          return {
            scannedGaps: 1,
            candidateGaps: 1,
            processedGaps: 1,
            createdGaps: 0,
            repairableGaps: 1,
            suppressedGaps: 0,
            skippedGaps: 0,
            searched: 1,
            ingestedSources: 1,
            linkedRepairs: 1,
            blockedGaps: 0,
            closedGaps: 1,
            queuedTasks: 1,
            requestedLimit: input.limit,
            effectiveLimit: 1,
            truncated: false,
            budgetExhausted: false,
            taskIds: ['kref-gap-1'],
            ingestedSourceIds: ['src-2'],
            acceptedSourceIds: ['src-1'],
            promotedFactCount: 1,
            errors: [],
          };
        },
      };

      const summary = await executeHarnessJson<{
        readonly memoryRefinement?: {
          readonly status?: string;
          readonly taskCounts?: { readonly attention?: number };
          readonly semanticJobPublished?: boolean;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryRefinement?.status).toBe('attention');
      expect(summary.memoryRefinement?.taskCounts?.attention).toBe(1);
      expect(summary.memoryRefinement?.semanticJobPublished).toBe(true);

      const refinement = await executeHarnessJson<{
        readonly status: string;
        readonly taskCounts: { readonly attention: number; readonly blocked: number };
        readonly tasks: readonly {
          readonly taskId: string;
          readonly state: string;
          readonly acceptedSourceIds?: readonly string[];
          readonly ingestedSourceIds?: readonly string[];
          readonly inspectRoute: string;
          readonly rerunRoute: string;
        }[];
        readonly semanticSelfImprovementJob: { readonly id: string; readonly latestRun?: { readonly status: string } };
        readonly policy: string;
      }>(fixture, { mode: 'memory_refinement', includeParameters: true });
      expect(refinement.status).toBe('attention');
      expect(refinement.taskCounts.attention).toBe(1);
      expect(refinement.taskCounts.blocked).toBe(1);
      expect(refinement.tasks[0]?.taskId).toBe('kref-gap-1');
      expect(refinement.tasks[0]?.acceptedSourceIds).toEqual(['src-1']);
      expect(refinement.tasks[0]?.ingestedSourceIds).toEqual(['src-2']);
      expect(refinement.tasks[0]?.inspectRoute).toContain('memory action:"refinement"');
      expect(refinement.tasks[0]?.rerunRoute).toContain('memory action:"run_refinement"');
      expect(refinement.semanticSelfImprovementJob.id).toBe('knowledge-semantic-self-improvement');
      expect(refinement.semanticSelfImprovementJob.latestRun?.status).toBe('completed');
      expect(refinement.policy).toContain('Read-only');

      const run = await executeHarnessJson<{
        readonly status: string;
        readonly result: { readonly closedGaps: number; readonly acceptedSourceIds: readonly string[]; readonly ingestedSourceIds: readonly string[] };
        readonly nextRoutes: { readonly tasks: readonly string[] };
        readonly policy: string;
      }>(fixture, {
        mode: 'run_memory_refinement',
        knowledgeSpaceId: 'agent',
        gapIds: ['sem-gap-1'],
        sourceIds: ['src-1'],
        limit: 2,
        maxRunMs: 5_000,
        force: true,
        confirm: true,
        explicitUserRequest: 'Run a scoped semantic refinement.',
      });
      expect(run.status).toBe('completed');
      expect(run.result.closedGaps).toBe(1);
      expect(run.result.acceptedSourceIds).toEqual(['src-1']);
      expect(run.result.ingestedSourceIds).toEqual(['src-2']);
      expect(run.nextRoutes.tasks[0]).toContain('memory action:"refinement"');
      expect(run.policy).toContain('KnowledgeService.runRefinement');
      expect(runRequests[0]).toEqual({
        knowledgeSpaceId: 'agent',
        sourceIds: ['src-1'],
        gapIds: ['sem-gap-1'],
        limit: 2,
        maxRunMs: 5_000,
        force: true,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces durable external memory provider receipts without claiming live provider records', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'supermemory-sync-receipt.json',
      text: JSON.stringify({ providerId: 'supermemory', operation: 'sync', status: 'succeeded' }),
      metadata: {
        purpose: 'agent-memory-provider-receipt',
        providerId: 'supermemory',
        operation: 'sync',
        status: 'succeeded',
        createdAt: '2026-06-08T12:00:00.000Z',
        sourceCount: 12,
        redaction: 'summaries-only',
        nextRoute: 'memory action:"provider" providerId:"supermemory" includeParameters:true',
        correlationId: 'memory-sync-1',
        schemaStatus: 'certified',
        schemaVersion: 'goodvibes.external-memory.receipt.v1',
        publicationGuarantee: 'daemon stores confirmed external memory receipts token=memory-receipt-secret',
        publisher: 'goodvibes-daemon',
        provenance: ['method memory.providers.sync', 'sourceTool memory_provider.sync'],
        receiptId: 'supermemory-sync-1',
        receiptStatus: 'succeeded',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      attachMemoryApi(fixture);
      const summary = await executeHarnessJson<{
        readonly memoryPosture?: {
          readonly externalProviderRecordsPublished?: boolean;
          readonly externalProviderReceiptEvidenceFound?: boolean;
          readonly externalProviderReceiptEvidenceCount?: number;
          readonly externalProviderSetupGuideStatus?: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryPosture?.externalProviderRecordsPublished).toBe(false);
      expect(summary.memoryPosture?.externalProviderReceiptEvidenceFound).toBe(true);
      expect(summary.memoryPosture?.externalProviderReceiptEvidenceCount).toBe(1);
      expect(summary.memoryPosture?.externalProviderSetupGuideStatus).toBe('receipt-evidence-found');

      const posture = await executeHarnessJson<{
        readonly providers: readonly {
          readonly id: string;
          readonly status: string;
          readonly latestReceipt?: { readonly artifactId: string; readonly operation: string; readonly status: string; readonly sourceCount: number | null };
        }[];
        readonly externalMemory: {
          readonly status: string;
          readonly providerRecordsPublished: boolean;
          readonly receiptEvidenceFound: boolean;
          readonly receiptEvidenceCount: number;
          readonly setupGuideStatus: string;
          readonly latestReceipts: readonly {
            readonly artifactId: string;
            readonly providerId: string;
            readonly operation: string;
            readonly inspectRoute: string;
            readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
          }[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string }[];
          readonly receiptContract: { readonly status: string; readonly requiredFields: readonly string[] };
          readonly next: string;
        };
      }>(fixture, { mode: 'memory_posture', includeParameters: true, limit: 20 });
      expect(posture.externalMemory.status).toBe('receipt-evidence-found');
      expect(posture.externalMemory.providerRecordsPublished).toBe(false);
      expect(posture.externalMemory.receiptEvidenceFound).toBe(true);
      expect(posture.externalMemory.receiptEvidenceCount).toBe(1);
      expect(posture.externalMemory.setupGuideStatus).toBe('receipt-evidence-found');
      expect(posture.externalMemory.latestReceipts[0]).toMatchObject({
        artifactId: 'artifact-1',
        providerId: 'supermemory',
        operation: 'sync',
      });
      expect(posture.externalMemory.latestReceipts[0]?.certification?.schemaStatus).toBe('certified');
      expect(posture.externalMemory.latestReceipts[0]?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(posture.externalMemory.latestReceipts[0]?.certification?.receiptId).toBe('supermemory-sync-1');
      expect(posture.externalMemory.latestReceipts[0]?.certification?.missingSignals).toEqual([]);
      expect(posture.externalMemory.latestReceipts[0]?.inspectRoute).toContain('agent_artifacts show artifactId:"artifact-1"');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.status).toBe('artifact-evidence-found');
      expect(posture.externalMemory.receiptContract.status).toBe('artifact-evidence-found');
      expect(posture.externalMemory.receiptContract.requiredFields).toContain('nextRoute');
      expect(posture.externalMemory.next).toContain('keep Agent-local memory');
      const supermemory = posture.providers.find((provider) => provider.id === 'supermemory');
      expect(supermemory?.status).toBe('receipt-evidence-found');
      expect(supermemory?.latestReceipt).toMatchObject({
        artifactId: 'artifact-1',
        operation: 'sync',
        status: 'succeeded',
        sourceCount: 12,
      });

      const provider = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly configured?: boolean;
        readonly latestReceipt?: {
          readonly artifactId: string;
          readonly operation: string;
          readonly status: string;
          readonly redaction: string | null;
          readonly nextRoute: string;
          readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
        };
        readonly setupGuide?: {
          readonly status: string;
          readonly currentState: string;
          readonly safeFirstStep: string;
          readonly latestReceipt?: { readonly artifactId: string; readonly correlationId: string | null };
          readonly receiptHistory?: readonly { readonly artifactId: string }[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
          readonly receiptContract: { readonly status: string };
        };
      }>(fixture, { mode: 'memory_provider', providerId: 'supermemory' });
      expect(provider.id).toBe('supermemory');
      expect(provider.status).toBe('receipt-evidence-found');
      expect(provider.configured).toBe(true);
      expect(provider.latestReceipt).toMatchObject({
        artifactId: 'artifact-1',
        operation: 'sync',
        status: 'succeeded',
        redaction: 'summaries-only',
      });
      expect(provider.latestReceipt?.nextRoute).toContain('memory action:"provider"');
      expect(provider.latestReceipt?.certification?.schemaStatus).toBe('certified');
      expect(provider.latestReceipt?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(provider.latestReceipt?.certification?.receiptId).toBe('supermemory-sync-1');
      expect(provider.latestReceipt?.certification?.missingSignals).toEqual([]);
      expect(provider.setupGuide?.status).toBe('receipt-evidence-found');
      expect(provider.setupGuide?.currentState).toContain('artifact-1');
      expect(provider.setupGuide?.safeFirstStep).toContain('Agent-local memory');
      expect(provider.setupGuide?.latestReceipt).toMatchObject({
        artifactId: 'artifact-1',
        correlationId: 'memory-sync-1',
      });
      expect(provider.setupGuide?.receiptHistory?.[0]?.artifactId).toBe('artifact-1');
      expect(provider.setupGuide?.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.status).toBe('artifact-evidence-found');
      expect(provider.setupGuide?.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.inspectRoute).toContain('artifact-1');
      expect(provider.setupGuide?.receiptContract.status).toBe('artifact-evidence-found');
      expect(JSON.stringify(provider)).not.toContain('memory-receipt-secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('consumes live external memory provider read models when published by the host', async () => {
    const fixture = makeFixture();
    try {
      attachMemoryApi(fixture);
      const readModels = (fixture.context.platform as unknown as { readModels: Record<string, unknown> }).readModels;
      readModels.memory = {
        externalProviders: {
          getSnapshot: () => ({
            providers: {
              supermemory: {
                label: 'Supermemory',
                status: 'ready',
                configured: true,
                reachable: true,
                credentialRef: 'secret://supermemory-token',
                capabilities: {
                  read: true,
                  write: true,
                  sync: true,
                  forget: false,
                },
                promptPolicy: { eligible: false },
                routes: {
                  inspect: 'memory action:"provider" providerId:"supermemory" includeParameters:true',
                  read: 'memory_provider action:"read" providerId:"supermemory" query:"..."',
                  write: 'memory_provider action:"write" providerId:"supermemory" confirm:true explicitUserRequest:"..."',
                  sync: 'memory_provider action:"sync" providerId:"supermemory" confirm:true explicitUserRequest:"..."',
                  receipts: 'memory_provider action:"receipts" providerId:"supermemory"',
                },
                receiptIds: ['live-memory-receipt-1'],
                receiptStreamStatus: 'published',
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.external-memory.provider.v1',
                publicationGuarantee: 'daemon publishes external memory provider state token=memory-pub-secret',
                publisher: 'goodvibes-daemon',
                provenance: ['method memory.providers.list', 'sourceTool memory.externalProviders'],
                sourceCount: 12,
                recordCount: 45,
                redactionPolicy: 'summaries-only',
                updatedAt: '2026-06-08T12:00:00.000Z',
              },
            },
          }),
        },
      };

      const summary = await executeHarnessJson<{
        readonly memoryPosture?: {
          readonly externalProviderRecordsPublished?: boolean;
          readonly externalProviderLiveRecordCount?: number;
          readonly externalProviderSetupGuideStatus?: string;
        };
      }>(fixture, { mode: 'summary' });
      expect(summary.memoryPosture?.externalProviderRecordsPublished).toBe(true);
      expect(summary.memoryPosture?.externalProviderLiveRecordCount).toBe(1);
      expect(summary.memoryPosture?.externalProviderSetupGuideStatus).toBe('ready');

      const posture = await executeHarnessJson<{
        readonly providers: readonly {
          readonly id: string;
          readonly status: string;
          readonly configured?: boolean;
          readonly liveRecord?: {
            readonly source: string;
            readonly credentialState: string | null;
            readonly readReady: boolean | null;
            readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly receiptId?: string; readonly missingSignals: readonly string[] };
          };
          readonly setupGuide?: {
            readonly status: string;
            readonly contractChecklist: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
            readonly receiptContract: { readonly status: string };
            readonly nextRoutes: readonly { readonly id: string; readonly effect: string; readonly modelRoute: string }[];
          };
        }[];
        readonly externalMemory: {
          readonly status: string;
          readonly providerRecordsPublished: boolean;
          readonly liveProviderRecordCount: number;
          readonly latestLiveProviderRecords: readonly {
            readonly providerId: string;
            readonly source: string;
            readonly credentialState: string | null;
            readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] };
          }[];
          readonly setupGuideStatus: string;
          readonly checkedProviders: readonly string[];
          readonly contractChecklist: readonly { readonly id: string; readonly status: string }[];
          readonly receiptContract: { readonly status: string };
          readonly next: string;
        };
      }>(fixture, { mode: 'memory_posture', includeParameters: true, limit: 20 });
      expect(posture.externalMemory.status).toBe('available');
      expect(posture.externalMemory.providerRecordsPublished).toBe(true);
      expect(posture.externalMemory.liveProviderRecordCount).toBe(1);
      expect(posture.externalMemory.latestLiveProviderRecords[0]).toMatchObject({
        providerId: 'supermemory',
        source: 'context.platform.readModels.memory.externalProviders',
        credentialState: 'configured-secret-ref',
      });
      expect(posture.externalMemory.latestLiveProviderRecords[0]?.certification?.schemaStatus).toBe('certified');
      expect(posture.externalMemory.latestLiveProviderRecords[0]?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(posture.externalMemory.latestLiveProviderRecords[0]?.certification?.missingSignals).toEqual([]);
      expect(posture.externalMemory.setupGuideStatus).toBe('ready');
      expect(posture.externalMemory.checkedProviders).toContain('supermemory');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'certified-provider-contract')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'status-record')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'bounded-read-search')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'confirmed-write-upsert')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'forget-contract')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.status).toBe('published');
      expect(posture.externalMemory.contractChecklist.find((entry) => entry.id === 'prompt-eligibility-policy')?.status).toBe('published');
      expect(posture.externalMemory.receiptContract.status).toBe('published');
      expect(posture.externalMemory.next).toContain('live provider record');

      const supermemory = posture.providers.find((provider) => provider.id === 'supermemory');
      expect(supermemory?.status).toBe('available');
      expect(supermemory?.configured).toBe(true);
      expect(supermemory?.liveRecord).toMatchObject({
        source: 'context.platform.readModels.memory.externalProviders',
        credentialState: 'configured-secret-ref',
        readReady: true,
      });
      expect(supermemory?.liveRecord?.certification?.schemaStatus).toBe('certified');
      expect(supermemory?.liveRecord?.certification?.receiptId).toBe('live-memory-receipt-1');
      expect(supermemory?.liveRecord?.certification?.missingSignals).toEqual([]);
      expect(supermemory?.setupGuide?.status).toBe('ready');
      expect(supermemory?.setupGuide?.contractChecklist.find((entry) => entry.id === 'credential-reference')?.status).toBe('published');
      expect(supermemory?.setupGuide?.contractChecklist.find((entry) => entry.id === 'sync-receipts')?.inspectRoute).toContain('memory_provider action:"receipts"');
      expect(supermemory?.setupGuide?.receiptContract.status).toBe('published');
      expect(supermemory?.setupGuide?.nextRoutes.find((route) => route.id === 'read-provider-memory')?.effect).toBe('read-only');
      expect(supermemory?.setupGuide?.nextRoutes.find((route) => route.id === 'write-provider-memory')?.effect).toBe('confirmed');
      expect(supermemory?.setupGuide?.nextRoutes.find((route) => route.id === 'sync-provider-memory')?.modelRoute).toContain('confirm:true');

      const provider = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly liveRecord?: {
          readonly receiptIds: readonly string[];
          readonly recordCount: number | null;
          readonly redaction: string | null;
          readonly certification?: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] };
        };
        readonly setupGuide?: { readonly currentState: string; readonly safeFirstStep: string };
      }>(fixture, { mode: 'memory_provider', providerId: 'supermemory' });
      expect(provider.id).toBe('supermemory');
      expect(provider.status).toBe('available');
      expect(provider.liveRecord?.receiptIds).toContain('live-memory-receipt-1');
      expect(provider.liveRecord?.recordCount).toBe(45);
      expect(provider.liveRecord?.redaction).toBe('summaries-only');
      expect(provider.liveRecord?.certification?.schemaStatus).toBe('certified');
      expect(provider.liveRecord?.certification?.publicationGuarantee).toContain('token=<redacted>');
      expect(provider.liveRecord?.certification?.missingSignals).toEqual([]);
      expect(provider.setupGuide?.currentState).toContain('Live Supermemory provider record');
      expect(provider.setupGuide?.safeFirstStep).toContain('published bounded read route');
      expect(JSON.stringify(provider)).not.toContain('secret://supermemory-token');
      expect(JSON.stringify(provider)).not.toContain('memory-pub-secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('surfaces email and calendar MCP connectors as Personal Ops setup routes', async () => {
    const artifactStore = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifactStore.store });
    try {
      const mcpApi = fixture.context.clients?.mcpApi as {
        listServerSecurity: () => readonly unknown[];
        listAllTools?: () => Promise<readonly {
          readonly qualifiedName?: string;
          readonly serverName: string;
          readonly toolName: string;
          readonly description?: string;
        }[]>;
        getToolSchema?: (qualifiedName: string) => Promise<{
          readonly inputSchema?: unknown;
        } | null>;
        callTool?: (qualifiedName: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
      };
      const mcpToolCalls: Array<{ readonly qualifiedName: string; readonly input: Readonly<Record<string, unknown>> }> = [];
      mcpApi.listServerSecurity = () => [
        {
          name: 'filesystem',
          connected: true,
          trustMode: 'constrained',
          role: 'tools',
          schemaFreshness: 'fresh',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [fixture.root],
          allowedHosts: ['localhost'],
        },
        {
          name: 'gmail-inbox',
          connected: true,
          trustMode: 'constrained',
          role: 'tools',
          schemaFreshness: 'fresh',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [],
          allowedHosts: ['mail.example.test'],
        },
        {
          name: 'caldav-agenda',
          connected: false,
          trustMode: 'ask-on-risk',
          role: 'tools',
          schemaFreshness: 'stale',
          quarantineReason: null,
          quarantineDetail: null,
          allowedPaths: [],
          allowedHosts: ['calendar.example.test'],
        },
      ];
      mcpApi.listAllTools = async () => [
        {
          qualifiedName: 'mcp:gmail-inbox:gmail.search_messages',
          serverName: 'gmail-inbox',
          toolName: 'gmail.search_messages',
          description: 'Search unread email messages and threads.',
        },
        {
          qualifiedName: 'mcp:gmail-inbox:gmail.get_thread',
          serverName: 'gmail-inbox',
          toolName: 'gmail.get_thread',
          description: 'Read one email thread by id.',
        },
        {
          qualifiedName: 'mcp:gmail-inbox:gmail.send_reply',
          serverName: 'gmail-inbox',
          toolName: 'gmail.send_reply',
          description: 'Send a reply to an email thread.',
        },
        {
          qualifiedName: 'mcp:caldav-agenda:caldav.list_events',
          serverName: 'caldav-agenda',
          toolName: 'caldav.list_events',
          description: 'List upcoming calendar events.',
        },
        {
          qualifiedName: 'mcp:caldav-agenda:caldav.update_event',
          serverName: 'caldav-agenda',
          toolName: 'caldav.update_event',
          description: 'Edit or reschedule a calendar event.',
        },
      ];
      mcpApi.getToolSchema = async (qualifiedName) => {
        if (qualifiedName === 'mcp:gmail-inbox:gmail.search_messages') {
          return {
            inputSchema: {
              type: 'object',
              required: ['query'],
              properties: {
                query: { type: 'string' },
                limit: { type: 'number' },
                mailbox: { type: 'string' },
                unreadOnly: { type: 'boolean' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:gmail-inbox:gmail.get_thread') {
          return {
            inputSchema: {
              type: 'object',
              required: ['threadId'],
              properties: {
                threadId: { type: 'string' },
                includeAttachments: { type: 'boolean' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:gmail-inbox:gmail.send_reply') {
          return {
            inputSchema: {
              type: 'object',
              required: ['threadId', 'body'],
              properties: {
                threadId: { type: 'string' },
                body: { type: 'string' },
                dryRun: { type: 'boolean' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:caldav-agenda:caldav.list_events') {
          return {
            inputSchema: {
              type: 'object',
              required: ['start', 'end'],
              properties: {
                start: { type: 'string' },
                end: { type: 'string' },
                calendarId: { type: 'string' },
              },
            },
          };
        }
        if (qualifiedName === 'mcp:caldav-agenda:caldav.update_event') {
          return {
            inputSchema: {
              type: 'object',
              required: ['eventId'],
              properties: {
                eventId: { type: 'string' },
                title: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
              },
            },
          };
        }
        return null;
      };
      mcpApi.callTool = async (qualifiedName, input) => {
        mcpToolCalls.push({ qualifiedName, input });
        if (qualifiedName === 'mcp:gmail-inbox:gmail.search_messages') {
          return {
            content: [{
              type: 'text',
              text: 'Subject: Quarterly planning\nFrom: lead@example.test\nBody: unblock proposal review. token=SECRET123 password=hunter2',
            }],
            structuredContent: {
              messages: [{
                id: 'msg-1',
                threadId: 'thread-1',
                subject: 'Quarterly planning',
                from: 'lead@example.test',
                receivedAt: '2026-06-06T14:00:00Z',
                snippet: 'unblock proposal review token=SECRET123',
              }],
            },
          };
        }
        throw new Error(`Unexpected MCP tool call: ${qualifiedName}`);
      };

      const ops = await executeHarnessJson<{
        readonly workflowSummary: { readonly ready: number; readonly attention: number };
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly modelRoute: string;
          readonly workflows?: readonly {
            readonly id: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly inspectRoutes?: readonly string[];
            readonly prerequisites?: readonly string[];
            readonly runBoundary?: string;
          }[];
          readonly connectorSignals?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly toolCount: number;
            readonly capabilityTags?: readonly string[];
            readonly readTools?: readonly {
              readonly name: string;
              readonly qualifiedName?: string;
              readonly capability: string;
              readonly schemaRoute?: string;
              readonly requiredFields?: readonly string[];
              readonly sampleInput?: Record<string, unknown>;
            }[];
            readonly writeTools?: readonly {
              readonly name: string;
              readonly effect: string;
              readonly schemaRoute?: string;
              readonly requiredFields?: readonly string[];
              readonly sampleInput?: Record<string, unknown>;
            }[];
          }[];
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label?: string;
            readonly status: string;
            readonly modelRoute: string;
            readonly effect?: string;
            readonly capability?: string;
            readonly qualifiedName?: string;
            readonly requiredFields?: readonly string[];
            readonly sampleInput?: Record<string, unknown>;
            readonly confirmationRequired?: boolean;
            readonly freshness?: {
              readonly status: string;
              readonly source: string;
              readonly sourceTool?: string;
              readonly refreshRoute?: string;
              readonly requiredFields?: readonly string[];
              readonly sampleInput?: Record<string, unknown>;
            };
          }[];
        }[];
      }>(fixture, { mode: 'personal_ops', includeParameters: true });

      const inbox = ops.lanes.find((lane) => lane.id === 'inbox');
      const calendar = ops.lanes.find((lane) => lane.id === 'calendar');
      expect(ops.workflowSummary.ready).toBeGreaterThan(0);
      expect(ops.workflowSummary.attention).toBeGreaterThan(0);
      expect(inbox?.status).toBe('partial');
      expect(inbox?.current).toContain('MCP connector');
      expect(inbox?.modelRoute).toContain('mcp_servers');
      expect(inbox?.connectorSignals?.[0]?.id).toBe('mcp:gmail-inbox');
      expect(inbox?.connectorSignals?.[0]?.status).toBe('ready');
      expect(inbox?.connectorSignals?.[0]?.modelRoute).toContain('gmail-inbox');
      expect(inbox?.connectorSignals?.[0]?.toolCount).toBe(3);
      expect(inbox?.connectorSignals?.[0]?.capabilityTags).toEqual(['inbox-read', 'inbox-write']);
      expect(inbox?.connectorSignals?.[0]?.readTools?.map((tool) => tool.name)).toEqual(['gmail.get_thread', 'gmail.search_messages']);
      expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.qualifiedName).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.schemaRoute).toContain('mcp:gmail-inbox:gmail.search_messages');
      expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.requiredFields).toEqual(['query']);
      expect(inbox?.connectorSignals?.[0]?.readTools?.[1]?.sampleInput?.query).toBe('is:unread newer_than:7d');
      expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.name).toBe('gmail.send_reply');
      expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.schemaRoute).toContain('mcp:gmail-inbox:gmail.send_reply');
      expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.requiredFields).toEqual(['body', 'threadId']);
      expect(inbox?.connectorSignals?.[0]?.writeTools?.[0]?.sampleInput?.body).toBe('<reviewed draft text>');
      expect(inbox?.workflows?.[0]?.id).toBe('inbox-triage-briefing');
      expect(inbox?.workflows?.[0]?.status).toBe('ready');
      expect(inbox?.workflows?.[0]?.inspectRoutes?.[0]).toContain('gmail-inbox');
      expect(inbox?.workflows?.[0]?.prerequisites?.join('\n')).toContain('classified read-only inbox tool');
      expect(inbox?.workflows?.[1]?.runBoundary).toContain('sending');
      expect(inbox?.workflows?.[1]?.prerequisites?.join('\n')).toContain('write-like inbox tool');
      expect(inbox?.liveRecords?.[0]?.id).toBe('mcp:gmail-inbox');
      const inboxSearchRecord = inbox?.liveRecords?.find((record) => record.id === 'mcp:gmail-inbox:gmail.search_messages');
      expect(inboxSearchRecord?.label).toContain('Inbox read');
      expect(inboxSearchRecord?.modelRoute).toContain('mcp schema');
      expect(inboxSearchRecord?.effect).toBe('read-only');
      expect(inboxSearchRecord?.capability).toBe('inbox-read');
      expect(inboxSearchRecord?.requiredFields).toEqual(['query']);
      expect(inboxSearchRecord?.sampleInput?.query).toBe('is:unread newer_than:7d');
      expect(inboxSearchRecord?.confirmationRequired).toBe(false);
      expect(inboxSearchRecord?.freshness).toMatchObject({
        status: 'fresh-provider-route-ready',
        source: 'connector-read',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
        requiredFields: ['query'],
      });
      expect(inboxSearchRecord?.freshness?.refreshRoute).toContain('personal_ops action:"read"');
      const inboxSendRecord = inbox?.liveRecords?.find((record) => record.id === 'mcp:gmail-inbox:gmail.send_reply');
      expect(inboxSendRecord?.effect).toBe('confirmed-effect');
      expect(inboxSendRecord?.confirmationRequired).toBe(true);
      expect(inboxSendRecord?.freshness).toBeUndefined();
      expect(inboxSendRecord?.sampleInput?.body).toBe('<reviewed draft text>');

      expect(calendar?.status).toBe('partial');
      expect(calendar?.connectorSignals?.[0]?.id).toBe('mcp:caldav-agenda');
      expect(calendar?.connectorSignals?.[0]?.status).toBe('attention');
      expect(calendar?.connectorSignals?.[0]?.capabilityTags).toEqual(['calendar-read', 'calendar-write']);
      expect(calendar?.connectorSignals?.[0]?.readTools?.[0]?.schemaRoute).toContain('mcp:caldav-agenda:caldav.list_events');
      expect(calendar?.connectorSignals?.[0]?.readTools?.[0]?.requiredFields).toEqual(['end', 'start']);
      expect(calendar?.workflows?.[0]?.status).toBe('attention');
      expect(calendar?.workflows?.[0]?.prerequisites?.join('\n')).toContain('trust/schema');
      const agendaRecord = calendar?.liveRecords?.find((record) => record.id === 'mcp:caldav-agenda:caldav.list_events');
      expect(agendaRecord?.modelRoute).toContain('mcp schema');
      expect(agendaRecord?.requiredFields).toEqual(['end', 'start']);
      expect(agendaRecord?.sampleInput?.start).toBe('<start-iso>');
      expect(agendaRecord?.freshness?.status).toBe('connector-attention');

      const inboxIntake = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly laneId: string;
          readonly status: string;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
          readonly requiredFields?: readonly string[];
          readonly missingFields?: readonly string[];
          readonly operation?: {
            readonly name: string;
            readonly qualifiedName?: string;
            readonly schemaRoute?: string;
            readonly sampleInput?: Record<string, unknown>;
          };
          readonly executionPlan?: readonly {
            readonly id: string;
            readonly routeKind: string;
            readonly effect: string;
            readonly requiresConfirmation: boolean;
            readonly qualifiedName?: string;
            readonly sampleInput?: Record<string, unknown>;
            readonly policy: string;
          }[];
          readonly nextSteps: readonly string[];
        };
        readonly laneRoute: string;
      }>(fixture, { mode: 'personal_ops_intake', query: 'Triage my unread email.', includeParameters: true });
      expect(inboxIntake.preferred.id).toBe('inbox-triage-briefing');
      expect(inboxIntake.preferred.laneId).toBe('inbox');
      expect(inboxIntake.preferred.status).toBe('ready');
      expect(inboxIntake.preferred.modelRoute).toContain('mcp:gmail-inbox:gmail.search_messages');
      expect(inboxIntake.preferred.requiresConfirmation).toBe(false);
      expect(inboxIntake.preferred.requiredFields).toEqual(['query']);
      expect(inboxIntake.preferred.missingFields).toEqual(['query']);
      expect(inboxIntake.preferred.operation?.name).toBe('gmail.search_messages');
      expect(inboxIntake.preferred.operation?.sampleInput?.query).toBe('is:unread newer_than:7d');
      expect(inboxIntake.preferred.executionPlan?.map((step) => step.routeKind)).toEqual(['connector-read', 'local-compose']);
      expect(inboxIntake.preferred.executionPlan?.[0]?.qualifiedName).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(inboxIntake.preferred.executionPlan?.[0]?.sampleInput?.query).toBe('is:unread newer_than:7d');
      expect(inboxIntake.preferred.executionPlan?.[0]?.requiresConfirmation).toBe(false);
      expect(inboxIntake.preferred.executionPlan?.[1]?.effect).toBe('local-only');
      expect(inboxIntake.preferred.nextSteps.join('\n')).toContain('bounded read/list/search route');
      expect(inboxIntake.laneRoute).toContain('laneId:"inbox"');

      const draftIntake = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly operation?: { readonly name: string; readonly qualifiedName?: string };
          readonly followUpOperation?: { readonly name: string; readonly confirmationRequired?: boolean };
          readonly executionPlan?: readonly {
            readonly id: string;
            readonly routeKind: string;
            readonly effect: string;
            readonly requiresConfirmation: boolean;
            readonly qualifiedName?: string;
            readonly policy: string;
          }[];
          readonly nextSteps: readonly string[];
        };
      }>(fixture, { mode: 'personal_ops_intake', query: 'Draft a reply to this email thread.', includeParameters: true });
      expect(draftIntake.preferred.id).toBe('inbox-draft-reply');
      expect(draftIntake.preferred.operation?.name).toBe('gmail.get_thread');
      expect(draftIntake.preferred.followUpOperation?.name).toBe('gmail.send_reply');
      expect(draftIntake.preferred.followUpOperation?.confirmationRequired).toBe(true);
      expect(draftIntake.preferred.executionPlan?.map((step) => step.routeKind)).toEqual(['connector-read', 'local-compose', 'connector-confirmed-effect']);
      expect(draftIntake.preferred.executionPlan?.[2]?.qualifiedName).toBe('mcp:gmail-inbox:gmail.send_reply');
      expect(draftIntake.preferred.executionPlan?.[2]?.requiresConfirmation).toBe(true);
      expect(draftIntake.preferred.executionPlan?.[2]?.policy).toContain('explicitly confirms');
      expect(draftIntake.preferred.nextSteps.join('\n')).toContain('separate confirmed connector action');

      const calendarIntake = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly laneId: string;
          readonly status: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
          readonly operation?: { readonly name: string; readonly connectorStatus?: string };
          readonly executionPlan?: readonly { readonly id: string; readonly routeKind: string; readonly status: string; readonly policy: string }[];
          readonly nextSteps: readonly string[];
        };
      }>(fixture, { mode: 'personal_ops_intake', query: 'Brief my calendar for today.', includeParameters: true });
      expect(calendarIntake.preferred.id).toBe('calendar-agenda-briefing');
      expect(calendarIntake.preferred.laneId).toBe('calendar');
      expect(calendarIntake.preferred.status).toBe('attention');
      expect(calendarIntake.preferred.modelRoute).toContain('mcp:caldav-agenda:caldav.list_events');
      expect(calendarIntake.preferred.missingFields).toEqual(['connector trust/schema freshness']);
      expect(calendarIntake.preferred.operation?.connectorStatus).toBe('attention');
      expect(calendarIntake.preferred.executionPlan?.[0]?.id).toBe('repair-connector-readiness');
      expect(calendarIntake.preferred.executionPlan?.[0]?.routeKind).toBe('setup');
      expect(calendarIntake.preferred.executionPlan?.[0]?.policy).toContain('schema freshness');
      expect(calendarIntake.preferred.nextSteps.join('\n')).toContain('Repair connector trust');

      const missingRead = await executeHarnessJson<{
        readonly status: string;
        readonly missingFields?: readonly string[];
        readonly sampleInput?: Record<string, unknown>;
        readonly runRoute?: string;
      }>(fixture, {
        mode: 'run_personal_ops_read',
        laneId: 'inbox',
        recordId: 'mcp:gmail-inbox:gmail.search_messages',
        includeParameters: true,
      });
      expect(missingRead.status).toBe('missing_fields');
      expect(missingRead.missingFields).toEqual(['query']);
      expect(missingRead.sampleInput?.query).toBe('is:unread newer_than:7d');
      expect(missingRead.runRoute).toContain('personal_ops action:"read"');
      expect(mcpToolCalls).toHaveLength(0);

      const unconfirmedRead = await executeHarnessJson<{
        readonly status: string;
        readonly inputPreview?: Record<string, unknown>;
        readonly policy?: string;
      }>(fixture, {
        mode: 'run_personal_ops_read',
        laneId: 'inbox',
        recordId: 'mcp:gmail-inbox:gmail.search_messages',
        fields: { query: 'is:unread newer_than:7d' },
      });
      expect(unconfirmedRead.status).toBe('needs_confirmation');
      expect(unconfirmedRead.inputPreview?.query).toBe('is:unread newer_than:7d');
      expect(unconfirmedRead.policy).toContain('live personal inbox/calendar data');
      expect(mcpToolCalls).toHaveLength(0);

      const executedRead = await executeHarnessJson<{
        readonly status: string;
        readonly record?: { readonly qualifiedName?: string };
        readonly input?: Record<string, unknown>;
        readonly output?: { readonly preview: string; readonly truncated: boolean; readonly redaction: string };
        readonly reviewSummary?: { readonly kind: string; readonly records: number; readonly source: string };
        readonly reviewRecords?: readonly {
          readonly id: string;
          readonly kind: string;
          readonly label: string;
          readonly summary: string;
          readonly sourceTool?: string;
          readonly followUpBoundary: string;
        }[];
        readonly savedReviewArtifact?: {
          readonly status: string;
          readonly artifactId?: string;
          readonly modelRoute?: string;
          readonly policy?: string;
        };
        readonly nextRoutes?: {
          readonly lane?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
          readonly queue?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
          readonly refresh?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
          readonly artifact?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
          readonly savedQueue?: { readonly modelRoute: string; readonly requiresConfirmation: boolean };
          readonly localDraft?: { readonly effect: string; readonly modelRoute: string; readonly requiresConfirmation: boolean };
          readonly sendBoundary?: { readonly modelRoute: string; readonly requiresConfirmation: boolean; readonly policy: string };
        };
        readonly followUp?: readonly string[];
      }>(fixture, {
        mode: 'run_personal_ops_read',
        laneId: 'inbox',
        recordId: 'mcp:gmail-inbox:gmail.search_messages',
        fields: {
          query: 'is:unread newer_than:7d',
          limit: '2',
          unreadOnly: 'true',
          saveReviewCards: 'true',
          artifactTitle: 'Inbox triage cards',
        },
        confirm: true,
        explicitUserRequest: 'Triage my unread inbox.',
        includeParameters: true,
      });
      expect(executedRead.status).toBe('executed');
      expect(executedRead.record?.qualifiedName).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(executedRead.input?.limit).toBe(2);
      expect(executedRead.input?.unreadOnly).toBe(true);
      expect(executedRead.output?.preview).toContain('Quarterly planning');
      expect(executedRead.output?.preview).toContain('token=<redacted>');
      expect(executedRead.output?.preview).toContain('password=<redacted>');
      expect(executedRead.output?.preview).not.toContain('SECRET123');
      expect(executedRead.reviewSummary).toEqual({
        kind: 'inbox',
        records: 1,
        source: 'mcp:gmail-inbox:gmail.search_messages',
      });
      expect(executedRead.reviewRecords?.[0]?.id).toBe('msg-1');
      expect(executedRead.reviewRecords?.[0]?.kind).toBe('inbox-message');
      expect(executedRead.reviewRecords?.[0]?.label).toBe('Quarterly planning');
      expect(executedRead.reviewRecords?.[0]?.summary).toContain('from lead@example.test');
      expect(executedRead.reviewRecords?.[0]?.summary).toContain('token=<redacted>');
      expect(executedRead.reviewRecords?.[0]?.summary).not.toContain('SECRET123');
      expect(executedRead.reviewRecords?.[0]?.sourceTool).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(executedRead.reviewRecords?.[0]?.followUpBoundary).toContain('separate confirmed route');
      expect(executedRead.savedReviewArtifact?.status).toBe('saved');
      expect(executedRead.savedReviewArtifact?.artifactId).toBe('artifact-1');
      expect(executedRead.savedReviewArtifact?.modelRoute).toContain('agent_artifacts');
      expect(executedRead.savedReviewArtifact?.policy).toContain('redacted review cards');
      expect(executedRead.nextRoutes?.lane?.modelRoute).toBe('personal_ops action:"lane" laneId:"inbox" includeParameters:true');
      expect(executedRead.nextRoutes?.lane?.requiresConfirmation).toBe(false);
      expect(executedRead.nextRoutes?.queue?.modelRoute).toBe('personal_ops action:"queue" query:"inbox" includeParameters:true');
      expect(executedRead.nextRoutes?.refresh?.modelRoute).toContain('personal_ops action:"read"');
      expect(executedRead.nextRoutes?.refresh?.modelRoute).toContain('recordId:"mcp:gmail-inbox:gmail.search_messages"');
      expect(executedRead.nextRoutes?.refresh?.requiresConfirmation).toBe(true);
      expect(executedRead.nextRoutes?.artifact?.modelRoute).toBe('agent_artifacts show artifactId:"artifact-1" includeContent:true');
      expect(executedRead.nextRoutes?.artifact?.requiresConfirmation).toBe(false);
      expect(executedRead.nextRoutes?.savedQueue?.modelRoute).toBe('personal_ops action:"queue" query:"artifact-1" includeParameters:true');
      expect(executedRead.nextRoutes?.localDraft?.effect).toBe('local-only');
      expect(executedRead.nextRoutes?.localDraft?.modelRoute).toContain('artifact-1');
      expect(executedRead.nextRoutes?.localDraft?.requiresConfirmation).toBe(false);
      expect(executedRead.nextRoutes?.sendBoundary?.modelRoute).toContain('personal_ops action:"intake"');
      expect(executedRead.nextRoutes?.sendBoundary?.requiresConfirmation).toBe(true);
      expect(executedRead.nextRoutes?.sendBoundary?.policy).toContain('exact recipients and body');
      expect(executedRead.followUp?.join('\n')).toContain('explicit confirmation');
      expect(mcpToolCalls).toEqual([{
        qualifiedName: 'mcp:gmail-inbox:gmail.search_messages',
        input: { query: 'is:unread newer_than:7d', limit: 2, unreadOnly: true },
      }]);
      expect(artifactStore.records).toHaveLength(1);
      expect(artifactStore.records[0]?.metadata).toMatchObject({
        purpose: 'personal-ops-review-cards',
        laneId: 'inbox',
        sourceRecordId: 'mcp:gmail-inbox:gmail.search_messages',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
        reviewRecordCount: 1,
        reviewLabels: ['Quarterly planning'],
        reviewKinds: ['inbox-message'],
        reviewRecordIds: ['msg-1'],
        fullRawConnectorOutputStored: false,
      });
      const savedArtifact = await artifactStore.store.readContent('artifact-1');
      const savedText = savedArtifact.buffer.toString('utf-8');
      expect(savedText).toContain('"reviewRecords"');
      expect(savedText).toContain('Quarterly planning');
      expect(savedText).toContain('token=<redacted>');
      expect(savedText).not.toContain('SECRET123');
      expect(savedText).toContain('"inputFieldKeys"');
      expect(savedText).not.toContain('is:unread newer_than:7d');

      const briefing = await executeHarnessJson<{
        readonly status: string;
        readonly title: string;
        readonly readiness: { readonly ready: number; readonly attention: number; readonly 'needs-setup': number };
        readonly steps: readonly {
          readonly id: string;
          readonly status: string;
          readonly next: string;
          readonly modelRoute: string;
          readonly inspectRoutes: readonly string[];
          readonly evidence: readonly string[];
          readonly sourceCounts: {
            readonly refreshableSavedRecords?: number;
            readonly freshProviderReads?: number;
            readonly attentionWorkflows?: number;
          };
          readonly confirmationBoundary: string;
        }[];
        readonly routes?: { readonly liveReadTemplate?: string; readonly autonomyQueue?: string };
        readonly missingContracts?: readonly string[];
        readonly policy?: string;
      }>(fixture, {
        mode: 'personal_ops_briefing',
        query: 'Build my daily personal ops brief.',
        includeParameters: true,
      });
      expect(briefing.status).toBe('attention');
      expect(briefing.title).toContain('Daily Personal Ops');
      expect(briefing.readiness.ready).toBeGreaterThan(0);
      expect(briefing.readiness.attention).toBeGreaterThan(0);
      expect(briefing.routes?.liveReadTemplate).toContain('personal_ops action:"read"');
      expect(briefing.routes?.autonomyQueue).toBe('autonomy action:"queue"');
      expect(briefing.policy).toContain('read-only');
      expect(briefing.steps.map((step) => step.id)).toEqual(expect.arrayContaining([
        'inbox',
        'calendar',
        'tasks',
        'reminders',
        'delivery',
        'notes',
        'autonomy-queue',
      ]));
      const inboxBrief = briefing.steps.find((step) => step.id === 'inbox');
      expect(inboxBrief?.status).toBe('attention');
      expect(inboxBrief?.modelRoute).toContain('personal_ops action:"lane"');
      expect(inboxBrief?.inspectRoutes.join('\n')).toContain('laneId:"inbox"');
      expect(inboxBrief?.evidence.join('\n')).toContain('1 refreshable saved inbox queue item(s)');
      expect(inboxBrief?.sourceCounts.refreshableSavedRecords).toBeGreaterThan(0);
      expect(inboxBrief?.sourceCounts.freshProviderReads).toBeGreaterThan(0);
      expect(inboxBrief?.confirmationBoundary).toContain('separate confirmed route');
      const calendarBrief = briefing.steps.find((step) => step.id === 'calendar');
      expect(calendarBrief?.status).toBe('attention');
      expect(calendarBrief?.next).toContain('Repair connector trust');
      expect(calendarBrief?.sourceCounts.attentionWorkflows).toBeGreaterThan(0);
      const autonomyBrief = briefing.steps.find((step) => step.id === 'autonomy-queue');
      expect(autonomyBrief?.status).toBe('ready');
      expect(autonomyBrief?.confirmationBoundary).toContain('separate confirmed route');
      expect(briefing.missingContracts?.join('\n')).toContain('Calendar');

      const compactBriefing = await executeHarnessJson<{
        readonly steps: readonly { readonly id: string; readonly evidence: readonly string[] }[];
      }>(fixture, { mode: 'personal_ops_briefing' });
      expect(compactBriefing.steps.find((step) => step.id === 'inbox')?.evidence.join('\n')).toContain('1 email-like MCP connector(s)');
      expect(compactBriefing.steps.find((step) => step.id === 'calendar')?.evidence.join('\n')).toContain('1 calendar-like MCP connector(s)');

      const blockedWrite = await executeHarnessJson<{
        readonly status: string;
        readonly reason?: string;
        readonly policy?: string;
      }>(fixture, {
        mode: 'run_personal_ops_read',
        laneId: 'inbox',
        recordId: 'mcp:gmail-inbox:gmail.send_reply',
        fields: { threadId: 'thread-1', body: 'Reviewed reply.' },
        confirm: true,
        explicitUserRequest: 'Send the reviewed reply.',
      });
      expect(blockedWrite.status).toBe('blocked');
      expect(blockedWrite.reason).toBe('not_read_only');
      expect(blockedWrite.policy).toContain('refuses send');
      expect(mcpToolCalls).toHaveLength(1);

      const lane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly signals: readonly string[];
        readonly connectorSignals?: readonly { readonly id: string; readonly modelRoute: string; readonly readTools?: readonly { readonly name: string }[] }[];
        readonly workflows?: readonly { readonly id: string; readonly inspectRoutes?: readonly string[]; readonly prerequisites?: readonly string[] }[];
        readonly liveRecords?: readonly {
          readonly id: string;
          readonly label: string;
          readonly modelRoute: string;
          readonly effect?: string;
          readonly capability?: string;
          readonly artifactId?: string;
          readonly reviewRecordCount?: number;
          readonly reviewLabels?: readonly string[];
          readonly sourceTool?: string;
          readonly freshness?: {
            readonly status: string;
            readonly source: string;
            readonly sourceTool?: string;
            readonly refreshRoute?: string;
            readonly requiredFields?: readonly string[];
            readonly sampleInput?: Record<string, unknown>;
            readonly policy?: string;
          };
          readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string }[];
        }[];
      }>(fixture, { mode: 'personal_ops_lane', laneId: 'inbox', includeParameters: true });
      expect(lane.id).toBe('inbox');
      expect(lane.status).toBe('partial');
      expect(lane.signals).toContain('1 refreshable saved inbox queue item(s)');
      const savedThreadRecord = lane.liveRecords?.find((record) => record.id === 'review-thread:artifact-1:msg-1');
      expect(savedThreadRecord?.label).toContain('Saved thread');
      expect(savedThreadRecord?.capability).toBe('inbox-thread-review');
      expect(savedThreadRecord?.freshness).toMatchObject({
        status: 'saved-review-refreshable',
        source: 'saved-review-artifact',
        sourceTool: 'mcp:gmail-inbox:gmail.search_messages',
        requiredFields: ['query'],
      });
      expect(savedThreadRecord?.freshness?.refreshRoute).toContain('recordId:"mcp:gmail-inbox:gmail.search_messages"');
      expect(savedThreadRecord?.freshness?.sampleInput?.query).toBe('is:unread newer_than:7d');
      expect(savedThreadRecord?.followUpRoutes?.find((route) => route.id === 'refresh-saved-thread')?.requiresConfirmation).toBe(true);
      expect(savedThreadRecord?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.requiresConfirmation).toBe(true);
      const savedReviewRecord = lane.liveRecords?.find((record) => record.id === 'review-artifact:artifact-1');
      expect(savedReviewRecord?.label).toContain('Saved inbox review');
      expect(savedReviewRecord?.modelRoute).toContain('artifact-1');
      expect(savedReviewRecord?.effect).toBe('read-only');
      expect(savedReviewRecord?.capability).toBe('inbox-review-artifact');
      expect(savedReviewRecord?.artifactId).toBe('artifact-1');
      expect(savedReviewRecord?.reviewRecordCount).toBe(1);
      expect(savedReviewRecord?.reviewLabels).toEqual(['Quarterly planning']);
      expect(savedReviewRecord?.sourceTool).toBe('mcp:gmail-inbox:gmail.search_messages');
      expect(savedReviewRecord?.freshness?.status).toBe('saved-review-refreshable');
      expect(lane.connectorSignals?.[0]?.modelRoute).toContain('mcp_server');
      expect(lane.connectorSignals?.[0]?.readTools?.[0]?.name).toBe('gmail.get_thread');
      expect(lane.workflows?.[0]?.inspectRoutes?.[0]).toContain('gmail-inbox');
      expect(lane.workflows?.[0]?.prerequisites?.join('\n')).toContain('classified read-only inbox tool');

      const queue = await executeHarnessJson<{
        readonly status: string;
        readonly returned: number;
        readonly total: number;
        readonly summary: {
          readonly inbox: number;
          readonly calendar: number;
          readonly freshProviderReads: number;
          readonly refreshableSavedRecords: number;
          readonly savedReviewRecords: number;
          readonly attentionRecords: number;
          readonly confirmedFollowUps: number;
        };
        readonly queue: readonly {
          readonly queueItemId: string;
          readonly laneId: string;
          readonly type: string;
          readonly capability?: string;
          readonly freshness?: {
            readonly status: string;
            readonly refreshRoute?: string;
            readonly refreshRequiresConfirmation?: boolean;
          };
          readonly routes: {
            readonly lane: string;
            readonly inspect: string;
            readonly refresh?: string;
            readonly artifact?: string;
          };
          readonly followUpRoutes?: readonly { readonly id: string; readonly requiresConfirmation: boolean; readonly modelRoute: string }[];
        }[];
        readonly routes: { readonly liveReadTemplate: string };
        readonly policy: string;
      }>(fixture, { mode: 'personal_ops_queue', includeParameters: true });
      expect(queue.status).toBe('attention');
      expect(queue.total).toBeGreaterThanOrEqual(5);
      expect(queue.returned).toBe(queue.queue.length);
      expect(queue.summary.inbox).toBeGreaterThan(0);
      expect(queue.summary.calendar).toBeGreaterThan(0);
      expect(queue.summary.freshProviderReads).toBeGreaterThan(0);
      expect(queue.summary.refreshableSavedRecords).toBeGreaterThan(0);
      expect(queue.summary.savedReviewRecords).toBeGreaterThan(0);
      expect(queue.summary.attentionRecords).toBeGreaterThan(0);
      expect(queue.summary.confirmedFollowUps).toBeGreaterThan(0);
      expect(queue.routes.liveReadTemplate).toContain('personal_ops action:"read"');
      expect(queue.policy).toContain('read-only');
      const queueThread = queue.queue.find((record) => record.queueItemId === 'inbox:review-thread:artifact-1:msg-1');
      expect(queueThread?.type).toBe('saved-inbox-thread');
      expect(queueThread?.freshness?.status).toBe('saved-review-refreshable');
      expect(queueThread?.freshness?.refreshRequiresConfirmation).toBe(true);
      expect(queueThread?.routes.refresh).toContain('recordId:"mcp:gmail-inbox:gmail.search_messages"');
      expect(queueThread?.routes.artifact).toContain('artifact-1');
      expect(queueThread?.followUpRoutes?.find((route) => route.id === 'send-reviewed-reply-boundary')?.requiresConfirmation).toBe(true);
      const providerRead = queue.queue.find((record) => record.type === 'fresh-provider-read' && record.capability === 'inbox-read');
      expect(providerRead?.freshness?.status).toBe('fresh-provider-route-ready');
      expect(providerRead?.routes.lane).toBe('personal_ops action:"lane" laneId:"inbox"');

      const compactQueue = await executeHarnessJson<{
        readonly queue: readonly { readonly queueItemId: string }[];
        readonly total: number;
      }>(fixture, { mode: 'personal_ops_queue', query: 'review-thread:artifact-1:msg-1', limit: 1 });
      expect(compactQueue.total).toBe(1);
      expect(compactQueue.queue).toHaveLength(1);
      expect(compactQueue.queue[0]?.queueItemId).toBe('inbox:review-thread:artifact-1:msg-1');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a visible autonomy queue with owners and cancel routes', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const now = 1_700_000_100_000;
      const watcherReceipt = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'watcher-run-receipt.json',
        text: JSON.stringify({ receipt: 'Gmail watcher event was captured with metadata-only redaction.' }),
        metadata: {
          purpose: 'connected-host-watcher-run-receipt',
          operation: 'gmail-message-trigger',
          status: 'succeeded',
          watcherId: 'watcher-gmail-inbox',
          runId: 'auto-run-receipt-1',
          providerId: 'gmail',
          triggerKind: 'gmail-message',
          correlationId: 'corr-watcher-1',
          redaction: 'metadata-only',
          payloadRedacted: true,
          sourceTool: 'mcp:gmail.watch',
          recordedAt: '2023-11-14T22:15:00.000Z',
        },
      });
      const researchRunRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const run = researchRunRegistry.create({
        title: 'Market map research',
        question: 'Which competitor research features need parity?',
        nextSteps: ['Read source queue'],
      });
      researchRunRegistry.start(run.id, 'Starting competitor map.');
      researchRunRegistry.checkpoint(run.id, {
        phase: 'reading',
        status: 'blocked',
        progress: 35,
        note: 'Waiting on source review before synthesis.',
        sourceIds: ['source-a'],
        nextSteps: ['Review source-a'],
      });
      const readModels = fixture.context.platform.readModels as unknown as Record<string, unknown>;
      const automationSource = {
        id: 'schedule-source-live',
        kind: 'schedule',
        label: 'Daily operator brief',
        enabled: true,
        createdAt: now - 600_000,
        updatedAt: now - 60_000,
        metadata: {},
      };
      const automationExecution = {
        prompt: 'Summarize overnight operator posture.',
        target: { kind: 'background' },
      };
      const automationDelivery = {
        mode: 'surface',
        targets: [],
        fallbackTargets: [],
        includeSummary: true,
        includeTranscript: false,
        includeLinks: true,
      };
      const automationFailure = {
        action: 'retry',
        maxConsecutiveFailures: 3,
        cooldownMs: 60_000,
        retryPolicy: {
          maxAttempts: 2,
          delayMs: 30_000,
          strategy: 'fixed',
        },
      };
      Object.assign(readModels, {
        tasks: {
          getSnapshot: () => ({
            tasks: [
              {
                id: 'host-task-live',
                kind: 'scheduler',
                title: 'Deliver scheduled brief',
                status: 'running',
                owner: 'scheduler',
                cancellable: true,
                childTaskIds: [],
                queuedAt: now - 120_000,
                startedAt: now - 60_000,
                correlationId: 'corr-live',
              },
              {
                id: 'host-task-failed',
                kind: 'daemon',
                title: 'Retry failed sync',
                status: 'failed',
                owner: 'daemon',
                cancellable: false,
                childTaskIds: [],
                queuedAt: now - 300_000,
                startedAt: now - 240_000,
                endedAt: now - 180_000,
                error: 'network timeout token=host-secret-token',
                retryPolicy: {
                  maxAttempts: 3,
                  currentAttempt: 1,
                  delayMs: 60_000,
                  backoff: 'exponential',
                  retryOn: ['network'],
                },
                retryAt: now + 60_000,
              },
            ],
          }),
          subscribe: () => () => {},
        },
        automation: {
          getSnapshot: () => ({
            jobs: [{
              id: 'sched-live-1',
              labels: ['operator-brief'],
              createdAt: now - 600_000,
              updatedAt: now - 30_000,
              name: 'Daily operator brief',
              status: 'enabled',
              enabled: true,
              schedule: { kind: 'cron', expression: '0 9 * * *', timezone: 'America/Chicago' },
              execution: automationExecution,
              delivery: automationDelivery,
              failure: automationFailure,
              source: automationSource,
              nextRunAt: now + 3_600_000,
              lastRunAt: now - 86_400_000,
              lastRunId: 'auto-run-1',
              runCount: 2,
              successCount: 1,
              failureCount: 1,
              deleteAfterRun: false,
            }],
            runs: [{
              id: 'auto-run-1',
              labels: ['operator-brief'],
              createdAt: now - 90_000,
              updatedAt: now - 15_000,
              jobId: 'sched-live-1',
              status: 'running',
              agentId: 'agent-live-1',
              triggeredBy: automationSource,
              target: { kind: 'background' },
              execution: automationExecution,
              scheduleKind: 'cron',
              queuedAt: now - 90_000,
              startedAt: now - 75_000,
              forceRun: false,
              dueRun: true,
              attempt: 2,
              sessionId: 'session-alpha',
              routeId: 'route-live-1',
              route: {
                id: 'route-live-1',
                kind: 'thread',
                surfaceKind: 'slack',
                surfaceId: 'surface-live-1',
                externalId: 'C0123',
                threadId: '1700000000.000100',
                channelId: 'C0123',
                sessionId: 'session-alpha',
                jobId: 'sched-live-1',
                runId: 'auto-run-1',
                title: 'Ops daily brief',
                lastSeenAt: now - 15_000,
                createdAt: now - 90_000,
                updatedAt: now - 15_000,
                metadata: {},
              },
              continuationMode: 'background',
              executionIntent: { mode: 'background', targetKind: 'background' },
              deliveryIds: ['delivery-live-1'],
              deliveryAttempts: [{
                id: 'delivery-live-1',
                runId: 'auto-run-1',
                jobId: 'sched-live-1',
                target: { kind: 'surface', surfaceKind: 'slack', routeId: 'route-live-1' },
                status: 'sent',
                startedAt: now - 20_000,
                endedAt: now - 18_000,
                responseId: 'message-live-1',
              }],
              modelId: 'gpt-4.1',
              providerId: 'openai',
              telemetry: {
                usage: {
                  inputTokens: 1200,
                  outputTokens: 300,
                  cacheReadTokens: 100,
                  cacheWriteTokens: 20,
                  reasoningTokens: 40,
                },
                llmCallCount: 2,
                toolCallCount: 5,
                turnCount: 3,
                modelId: 'gpt-4.1',
                providerId: 'openai',
                reasoningSummaryPresent: true,
                source: 'local-agent',
              },
            }],
            totalJobs: 1,
            totalRuns: 1,
            activeRunIds: ['auto-run-1'],
            totalFailed: 0,
            sourceCount: 1,
            deliveryTotals: { succeeded: 1, failed: 0, deadLettered: 0 },
          }),
          subscribe: () => () => {},
        },
        watchers: {
          runHistory: {
            getSnapshot: () => ({
              records: [{
                id: 'watcher-run-live-1',
                runId: 'watcher-run-live-1',
                watcherId: 'watcher-gmail-inbox',
                sourceId: 'gmail-source-live',
                providerId: 'gmail',
                triggerKind: 'gmail-message',
                status: 'running',
                correlationId: 'corr-watcher-live',
                lastCheckpoint: 'history-id-123',
                outputChunks: [
                  'Gmail watcher captured metadata token=watcher-secret-token',
                  { summary: 'Queued visible automation run for new support thread.' },
                ],
                outputRoute: 'watchers action:"output" runId:"watcher-run-live-1"',
                inspectRoute: 'watchers action:"show-run" runId:"watcher-run-live-1"',
                cancelRoute: 'watchers action:"cancel-run" runId:"watcher-run-live-1" confirm:true explicitUserRequest:"..."',
                retryRoute: 'watchers action:"retry-run" runId:"watcher-run-live-1" confirm:true explicitUserRequest:"..."',
                updatedAt: now - 12_000,
              }],
            }),
          },
        },
        gmail: {
          sources: {
            getSnapshot: () => ({
              sources: [{
                id: 'gmail-source-live',
                sourceId: 'gmail-source-live',
                watcherId: 'watcher-gmail-inbox',
                providerId: 'gmail',
                sourceKind: 'gmail',
                enabled: true,
                scope: 'inbox.metadata',
                filter: 'label:urgent token=source-secret-token',
                lastCheckpoint: 'history-id-123',
                lastEventPreview: 'New urgent message token=source-secret-token',
                inspectRoute: 'gmail_source action:"show" sourceId:"gmail-source-live"',
                refreshRoute: 'gmail_source action:"refresh" sourceId:"gmail-source-live"',
                updatedAt: now - 11_000,
              }],
            }),
          },
        },
        controlPlane: {
          getSnapshot: () => ({
            connectionState: 'connected',
            activeClientIds: ['operator-client'],
            requestCount: 1,
            errorCount: 0,
            host: '127.0.0.1',
            port: 3421,
            clients: [],
            approvals: [{
              id: 'approval-live-1',
              callId: 'call-live-1',
              sessionId: 'session-alpha',
              routeId: 'route-live-1',
              status: 'pending',
              request: {
                callId: 'call-live-1',
                tool: 'shell.exec',
                args: { cmd: 'git status --short' },
                category: 'execute',
                analysis: {
                  classification: 'shell-command',
                  riskLevel: 'high',
                  summary: 'Run git status for the workspace.',
                  reasons: ['The action runs a shell command through the connected host.'],
                  target: 'git status --short',
                  targetKind: 'command',
                  surface: 'shell',
                  blastRadius: 'project',
                },
              },
              createdAt: now - 45_000,
              updatedAt: now - 30_000,
              metadata: { source: 'test' },
              audit: [{
                id: 'audit-live-1',
                action: 'created',
                actor: 'agent',
                actorSurface: 'tui',
                createdAt: now - 45_000,
                note: 'approval requested',
              }],
            }],
            sessions: [],
            recentEvents: [],
          }),
          subscribe: () => () => {},
        },
      });

      const summary = await executeHarnessJson<{
        readonly autonomyQueue?: { readonly items: number; readonly cancellable: number; readonly readOnly: boolean };
      }>(fixture, { mode: 'summary' });
      expect(summary.autonomyQueue?.items).toBeGreaterThanOrEqual(8);
      expect(summary.autonomyQueue?.cancellable).toBeGreaterThan(0);
      expect(summary.autonomyQueue?.readOnly).toBe(true);

      const queue = await executeHarnessJson<{
        readonly summary: { readonly items: number; readonly cancellable: number; readonly needsSetup: number };
        readonly queue: readonly {
          readonly queueItemId: string;
          readonly status: string;
          readonly owner: string;
          readonly cancellable: boolean;
          readonly current: string;
          readonly modelRoute: string;
          readonly inspectRoute: string;
          readonly cancelRoute?: string;
          readonly createRoute?: string;
          readonly liveRecords?: readonly {
            readonly id: string;
            readonly label: string;
            readonly status: string;
            readonly phase?: string;
            readonly summary: string;
            readonly progress?: number;
            readonly inspectRoute: string;
            readonly cancelRoute?: string;
            readonly checkpointRoute?: string;
            readonly pauseRoute?: string;
            readonly resumeRoute?: string;
            readonly logTail?: readonly string[];
            readonly output?: {
              readonly status: string;
              readonly route: string;
              readonly source: string;
              readonly preview?: string;
              readonly policy: string;
            };
            readonly diagnostics?: readonly string[];
            readonly sourceIds?: readonly string[];
            readonly nextSteps?: readonly string[];
            readonly availableControls?: readonly string[];
            readonly controls?: readonly {
              readonly id: string;
              readonly state: string;
              readonly effect: string;
              readonly confirmationRequired: boolean;
              readonly modelRoute?: string;
              readonly reason?: string;
            }[];
          }[];
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'autonomy_queue', includeParameters: true });
      expect(queue.summary.items).toBeGreaterThanOrEqual(8);
      expect(queue.summary.cancellable).toBeGreaterThan(0);
      expect(queue.policy).toContain('Visible autonomy queue is read-only');
      expectRowsHaveCompactModelRoutes(queue.queue);

      const workPlan = queue.queue.find((item) => item.queueItemId === 'visible-work-plan');
      const researchRuns = queue.queue.find((item) => item.queueItemId === 'research-runs');
      const hostTasks = queue.queue.find((item) => item.queueItemId === 'connected-host-tasks');
      const approvals = queue.queue.find((item) => item.queueItemId === 'pending-approvals');
      const automation = queue.queue.find((item) => item.queueItemId === 'automation-runs');
      const autonomousScheduleRequests = queue.queue.find((item) => item.queueItemId === 'autonomous-schedule-requests');
      const schedules = queue.queue.find((item) => item.queueItemId === 'connected-schedules');
      const routines = queue.queue.find((item) => item.queueItemId === 'routine-schedule-promotions');
      expect(workPlan?.owner).toBe('agent');
      expect(workPlan?.cancellable).toBe(true);
      expect(workPlan?.cancelRoute).toContain('workplan-status');
      expect(researchRuns?.status).toBe('attention');
      expect(researchRuns?.liveRecords?.[0]?.id).toBe('market-map-research');
      expect(researchRuns?.liveRecords?.[0]?.status).toBe('blocked');
      expect(researchRuns?.liveRecords?.[0]?.progress).toBe(35);
      expect(researchRuns?.liveRecords?.[0]?.inspectRoute).toContain('research action:"run"');
      expect(researchRuns?.liveRecords?.[0]?.cancelRoute).toContain('research action:"cancel"');
      expect(researchRuns?.liveRecords?.[0]?.checkpointRoute).toContain('research action:"checkpoint"');
      expect(researchRuns?.liveRecords?.[0]?.pauseRoute).toContain('research action:"pause"');
      expect(researchRuns?.liveRecords?.[0]?.resumeRoute).toContain('research action:"resume"');
      expect(researchRuns?.liveRecords?.[0]?.availableControls).toContain('checkpoint');
      expect(researchRuns?.liveRecords?.[0]?.availableControls).toContain('pause');
      expect(researchRuns?.liveRecords?.[0]?.availableControls).toContain('resume');
      expect(researchRuns?.liveRecords?.[0]?.controls?.find((control) => control.id === 'cancel')?.modelRoute).toContain('research action:"cancel"');
      expect(researchRuns?.liveRecords?.[0]?.controls?.find((control) => control.id === 'pause')?.modelRoute).toContain('research action:"pause"');
      expect(researchRuns?.liveRecords?.[0]?.controls?.find((control) => control.id === 'resume')?.modelRoute).toContain('research action:"resume"');
      expect(researchRuns?.liveRecords?.[0]?.logTail?.join('\n')).toContain('Waiting on source review before synthesis.');
      expect(researchRuns?.liveRecords?.[0]?.sourceIds).toContain('source-a');
      expect(researchRuns?.liveRecords?.[0]?.nextSteps).toContain('Review source-a');
      expect(hostTasks?.status).toBe('attention');
      expect(hostTasks?.cancellable).toBe(true);
      expect(hostTasks?.cancelRoute).toContain('tasks.cancel');
      expect(hostTasks?.liveRecords?.[0]?.id).toBe('host-task-live');
      expect(hostTasks?.liveRecords?.[0]?.inspectRoute).toBe('/tasks show host-task-live');
      expect(hostTasks?.liveRecords?.[0]?.cancelRoute).toContain('tasks.cancel');
      expect(hostTasks?.liveRecords?.[0]?.availableControls).toContain('cancel');
      expect(hostTasks?.liveRecords?.[0]?.output?.status).toBe('route-only');
      expect(hostTasks?.liveRecords?.[0]?.output?.route).toBe('/tasks output host-task-live');
      expect(hostTasks?.liveRecords?.[0]?.output?.source).toBe('not-published');
      expect(hostTasks?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('output route /tasks output host-task-live');
      expect(hostTasks?.liveRecords?.[0]?.controls?.find((control) => control.id === 'cancel')?.confirmationRequired).toBe(true);
      expect(hostTasks?.liveRecords?.[0]?.controls?.find((control) => control.id === 'cancel')?.modelRoute).toContain('tasks.cancel');
      const failedHostTask = hostTasks?.liveRecords?.find((record) => record.id === 'host-task-failed');
      expect(failedHostTask?.status).toBe('failed');
      expect(failedHostTask?.availableControls).toContain('retry');
      expect(failedHostTask?.controls?.find((control) => control.id === 'retry')?.modelRoute).toContain('tasks.retry');
      expect(failedHostTask?.logTail?.join('\n')).toContain('network timeout');
      expect(failedHostTask?.logTail?.join('\n')).not.toContain('host-secret-token');
      expect(failedHostTask?.output?.status).toBe('preview');
      expect(failedHostTask?.output?.route).toBe('/tasks output host-task-failed');
      expect(failedHostTask?.output?.source).toBe('runtime-task-error');
      expect(failedHostTask?.output?.preview).toContain('token=<redacted>');
      expect(failedHostTask?.output?.preview).not.toContain('host-secret-token');
      expect(failedHostTask?.diagnostics?.join('\n')).toContain('retry attempt 1/3');
      expect(failedHostTask?.diagnostics?.join('\n')).not.toContain('host-secret-token');
      expect(approvals?.owner).toBe('connected-host');
      expect(approvals?.status).toBe('attention');
      expect(approvals?.cancelRoute).toContain('approval-cancel');
      expect(approvals?.liveRecords?.[0]?.id).toBe('approval-live-1');
      expect(approvals?.liveRecords?.[0]?.status).toBe('pending');
      expect(approvals?.liveRecords?.[0]?.cancelRoute).toContain('approvals.cancel');
      expect(approvals?.liveRecords?.[0]?.availableControls).toContain('approve');
      expect(approvals?.liveRecords?.[0]?.controls?.find((control) => control.id === 'deny')?.modelRoute).toContain('approvals.deny');
      expect(approvals?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('approvals.approve');
      expect(approvals?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('approvals.deny');
      expect(automation?.status).toBe('active');
      expect(automation?.current).toContain('2 live watcher run/source record');
      expect(automation?.current).toContain('1 durable watcher/run receipt');
      expect(automation?.liveRecords?.[0]?.id).toBe('auto-run-1');
      expect(automation?.liveRecords?.[0]?.cancelRoute).toContain('automation.runs.cancel');
      expect(automation?.liveRecords?.[0]?.availableControls).toContain('cancel');
      expect(automation?.liveRecords?.[0]?.controls?.find((control) => control.id === 'retry')?.state).toBe('unavailable');
      expect(automation?.liveRecords?.[0]?.sourceIds).toContain('sched-live-1');
      expect(automation?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('telemetry usage input 1200 output 300');
      expect(automation?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('telemetry calls llm 2 tool 5 turns 3');
      expect(automation?.liveRecords?.[0]?.diagnostics?.join('\n')).toContain('delivery delivery-live-1 sent');
      const liveWatcherRun = automation?.liveRecords?.find((record) => record.id.includes('watcher-run-live-1'));
      expect(liveWatcherRun?.status).toBe('running');
      expect(liveWatcherRun?.phase).toBe('gmail-message');
      expect(liveWatcherRun?.inspectRoute).toContain('watchers action:"show-run"');
      expect(liveWatcherRun?.cancelRoute).toContain('watchers action:"cancel-run"');
      expect(liveWatcherRun?.availableControls).toContain('output');
      expect(liveWatcherRun?.availableControls).toContain('cancel');
      expect(liveWatcherRun?.controls?.find((control) => control.id === 'cancel')?.confirmationRequired).toBe(true);
      expect(liveWatcherRun?.controls?.find((control) => control.id === 'retry')?.state).toBe('unavailable');
      expect(liveWatcherRun?.output?.source).toBe('host-output-chunk');
      expect(liveWatcherRun?.output?.route).toContain('watchers action:"output"');
      expect(liveWatcherRun?.output?.preview).toContain('token=<redacted>');
      expect(liveWatcherRun?.output?.preview).not.toContain('watcher-secret-token');
      expect(liveWatcherRun?.sourceIds).toContain('watcher-gmail-inbox');
      expect(liveWatcherRun?.sourceIds).toContain('watcher-run-live-1');
      expect(liveWatcherRun?.diagnostics?.join('\n')).toContain('context.platform.readModels.watchers.runHistory');
      expect(liveWatcherRun?.diagnostics?.join('\n')).toContain('cancel route published');
      const liveSource = automation?.liveRecords?.find((record) => record.id.includes('watcher-source') && record.sourceIds?.includes('gmail-source-live'));
      expect(liveSource?.status).toBe('ready');
      expect(liveSource?.phase).toBe('gmail');
      expect(liveSource?.inspectRoute).toContain('gmail_source action:"show"');
      expect(liveSource?.availableControls).toEqual(['inspect', 'refresh']);
      expect(liveSource?.controls?.every((control) => control.effect === 'read-only')).toBe(true);
      expect(liveSource?.diagnostics?.join('\n')).toContain('filter label:urgent token=<redacted>');
      expect(liveSource?.diagnostics?.join('\n')).not.toContain('source-secret-token');
      expect(liveSource?.output?.source).toBe('provider-source-preview');
      expect(liveSource?.output?.preview).toContain('token=<redacted>');
      expect(liveSource?.output?.preview).not.toContain('source-secret-token');
      expect(liveSource?.diagnostics?.join('\n')).toContain('context.platform.readModels.gmail.sources');
      const watcherRecord = automation?.liveRecords?.find((record) => record.id === `watcher-receipt:${watcherReceipt.id}`);
      expect(watcherRecord?.status).toBe('succeeded');
      expect(watcherRecord?.phase).toBe('gmail-message');
      expect(watcherRecord?.summary).toContain('Redaction metadata-only');
      expect(watcherRecord?.summary).toContain('Payload redacted');
      expect(watcherRecord?.inspectRoute).toBe(`agent_artifacts show artifactId:"${watcherReceipt.id}" includeContent:false`);
      expect(watcherRecord?.availableControls).toEqual(['inspect', 'queue']);
      expect(watcherRecord?.controls?.every((control) => control.effect === 'read-only')).toBe(true);
      expect(watcherRecord?.sourceIds).toContain('watcher-gmail-inbox');
      expect(watcherRecord?.sourceIds).toContain('auto-run-receipt-1');
      expect(watcherRecord?.diagnostics?.join('\n')).toContain('purpose connected-host-watcher-run-receipt');
      expect(autonomousScheduleRequests?.modelRoute).toBe('schedule action:"create"');
      expect(autonomousScheduleRequests?.createRoute).toContain('successCriteria');
      expect(schedules?.status).toBe('active');
      expect(schedules?.cancellable).toBe(true);
      expect(schedules?.cancelRoute).toContain('schedule action:"pause"');
      expect(schedules?.liveRecords?.[0]?.id).toBe('sched-live-1');
      expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"run"');
      expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"edit"');
      expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"pause"');
      expect(schedules?.liveRecords?.[0]?.nextSteps?.join('\n')).toContain('schedule action:"delete"');
      expect(schedules?.liveRecords?.[0]?.cancelRoute).toContain('schedule action:"pause"');
      expect(schedules?.liveRecords?.[0]?.pauseRoute).toContain('schedule action:"pause"');
      expect(schedules?.liveRecords?.[0]?.availableControls).toContain('run');
      expect(schedules?.liveRecords?.[0]?.availableControls).toContain('pause');
      expect(schedules?.liveRecords?.[0]?.controls?.find((control) => control.id === 'pause')?.modelRoute).toContain('schedule action:"pause"');
      expect(schedules?.liveRecords?.[0]?.controls?.find((control) => control.id === 'delete')?.confirmationRequired).toBe(true);
      expect(schedules?.modelRoute).toContain('schedule action:"list|edit|run|pause|resume|delete"');
      expect(schedules?.createRoute).toContain('schedule action:"create"');
      expect(routines?.inspectRoute).toContain('schedule-receipts');

      const item = await executeHarnessJson<{
        readonly queueItemId: string;
        readonly routes?: { readonly inspect: string; readonly cancel: string | null };
        readonly liveRecords?: readonly { readonly id: string; readonly cancelRoute?: string; readonly inspectRoute: string }[];
      }>(fixture, { mode: 'autonomy_queue_item', queueItemId: 'automation-runs' });
      expect(item.queueItemId).toBe('automation-runs');
      expect(item.routes?.cancel).toContain('automation-run-cancel');
      expect(item.liveRecords?.[0]?.id).toBe('auto-run-1');
      expect(item.liveRecords?.[0]?.cancelRoute).toContain('automation.runs.cancel');
      expect(item.liveRecords?.find((record) => record.id === `watcher-receipt:${watcherReceipt.id}`)?.inspectRoute).toContain('agent_artifacts show');

      const researchItem = await executeHarnessJson<{
        readonly queueItemId: string;
        readonly liveRecords?: readonly { readonly id: string; readonly logTail?: readonly string[] }[];
      }>(fixture, { mode: 'autonomy_queue_item', queueItemId: 'research-runs' });
      expect(researchItem.queueItemId).toBe('research-runs');
      expect(researchItem.liveRecords?.[0]?.id).toBe('market-map-research');
      expect(researchItem.liveRecords?.[0]?.logTail?.join('\n')).toContain('Waiting on source review before synthesis.');

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'personal-ops-autonomy-queue' });
      expect(action.id).toBe('personal-ops-autonomy-queue');
      expect(action.modelRoute).toBe('autonomy action:"queue"');
    } finally {
      fixture.cleanup();
    }
  });

  test('routes ongoing-work requests through a conservative autonomy intake selector', async () => {
    const fixture = makeFixture();
    try {
      const missing = await executeHarnessJson<{
        readonly status: string;
        readonly usage?: string;
        readonly queueRoute?: string;
      }>(fixture, { mode: 'autonomy_intake' });
      expect(missing.status).toBe('missing_request');
      expect(missing.usage).toContain('query');
      expect(missing.queueRoute).toBe('autonomy action:"queue"');

      const reminder = await executeHarnessJson<{
        readonly status: string;
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
          readonly missingFields?: readonly string[];
        };
        readonly policy: string;
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Remind me every 2 hours to check the deploy.',
        includeParameters: true,
      });
      expect(reminder.status).toBe('ready');
      expect(reminder.preferred.id).toBe('one-reminder-or-simple-recurring-reminder');
      expect(reminder.preferred.modelRoute).toContain('schedule action:"remind"');
      expect(reminder.preferred.modelRoute).toContain('scheduleKind:"every"');
      expect(reminder.preferred.modelRoute).toContain('scheduleValue:"2h"');
      expect(reminder.preferred.requiresConfirmation).toBe(true);
      expect(reminder.preferred.missingFields).toBeUndefined();
      expect(reminder.policy).toContain('Autonomy intake is read-only');

      const autonomousSchedule = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
          readonly userQuestion?: string;
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Run a daily operator report.',
        includeParameters: true,
      });
      expect(autonomousSchedule.preferred.id).toBe('confirmed-autonomous-schedule');
      expect(autonomousSchedule.preferred.modelRoute).toContain('schedule action:"create"');
      expect(autonomousSchedule.preferred.modelRoute).toContain('successCriteria');
      expect(autonomousSchedule.preferred.missingFields).toContain('scheduleValue');
      expect(autonomousSchedule.preferred.missingFields).toContain('successCriteria');
      expect(autonomousSchedule.preferred.userQuestion).toContain('success criteria');

      const routine = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
          readonly userQuestion?: string;
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Run the weekly operator report as a reviewed routine.',
        includeParameters: true,
      });
      expect(routine.preferred.id).toBe('reviewed-routine-schedule');
      expect(routine.preferred.modelRoute).toContain('promote routine');
      expect(routine.preferred.missingFields).toContain('routineId');
      expect(routine.preferred.missingFields).toContain('scheduleValue');
      expect(routine.preferred.userQuestion).toContain('reviewed routine');

      const control = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly missingFields?: readonly string[];
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'Cancel the running automation run.',
      });
      expect(control.preferred.id).toBe('automation-control');
      expect(control.preferred.modelRoute).toContain('queueItemId:"automation-runs"');
      expect(control.preferred.missingFields?.join('\n')).toContain('runId');

      const trigger = await executeHarnessJson<{
        readonly preferred: {
          readonly id: string;
          readonly modelRoute: string;
          readonly requiresConfirmation: boolean;
          readonly missingFields?: readonly string[];
          readonly userQuestion?: string;
          readonly setupRoutes?: readonly string[];
          readonly triggerWorkflowId?: string;
        };
        readonly triggerWorkflowSummary: {
          readonly ready: number;
          readonly attention: number;
          readonly watcherEvidenceContractStatus: string | null;
          readonly watcherEvidenceMissing: readonly string[];
        };
        readonly triggerWorkflows: readonly {
          readonly id: string;
          readonly status: string;
          readonly requiredFields: readonly string[];
          readonly evidence: Record<string, unknown>;
          readonly outcome?: {
            readonly target: string;
            readonly successCriteria: readonly string[];
            readonly evidenceFields: readonly string[];
            readonly verificationRoute: string;
          };
          readonly evidenceContract?: {
            readonly status: string;
            readonly owner: string;
            readonly contractChecklist: readonly {
              readonly id: string;
              readonly status: string;
            }[];
            readonly receiptContract: {
              readonly appliesTo: readonly string[];
              readonly requiredFields: readonly string[];
            };
            readonly providerSourceContract: {
              readonly supportedSourceKinds: readonly string[];
              readonly requiredFields: readonly string[];
              readonly policy: string;
            };
          };
          readonly policy: string;
        }[];
        readonly watcherEvidenceContract: {
          readonly status: string;
          readonly owner: string;
          readonly contractChecklist: readonly {
            readonly id: string;
            readonly status: string;
          }[];
        };
      }>(fixture, {
        mode: 'autonomy_intake',
        query: 'When a webhook arrives from billing, run a triage brief.',
        includeParameters: true,
      });
      expect(trigger.preferred.id).toBe('visible-event-trigger-intake');
      expect(trigger.preferred.modelRoute).toContain('watchers.create');
      expect(trigger.preferred.requiresConfirmation).toBe(true);
      expect(trigger.preferred.missingFields?.join('\n')).toContain('trusted trigger source');
      expect(trigger.preferred.userQuestion).toContain('trusted event source');
      expect(trigger.preferred.setupRoutes?.join('\n')).toContain('watchers');
      expect(trigger.preferred.triggerWorkflowId).toBe('incoming-webhook-or-watcher');
      expect(trigger.triggerWorkflowSummary.ready).toBeGreaterThanOrEqual(2);
      expect(trigger.triggerWorkflowSummary.attention).toBeGreaterThanOrEqual(1);
      expect(trigger.triggerWorkflowSummary.watcherEvidenceContractStatus).toBe('contract-needed');
      expect(trigger.triggerWorkflowSummary.watcherEvidenceMissing).toContain('durable-run-history-records');
      expect(trigger.triggerWorkflowSummary.watcherEvidenceMissing).toContain('provider-source-records');
      expect(trigger.watcherEvidenceContract.status).toBe('contract-needed');
      expect(trigger.watcherEvidenceContract.owner).toBe('goodvibes-sdk-or-daemon');
      const watcher = trigger.triggerWorkflows.find((workflow) => workflow.id === 'incoming-webhook-or-watcher');
      expect(watcher?.status).toBe('ready');
      expect(watcher?.evidence.watcherCreatePublished).toBe(true);
      expect(watcher?.requiredFields.join('\n')).toContain('trusted trigger source');
      expect(watcher?.outcome?.target).toBe('created-visible-watcher');
      expect(watcher?.outcome?.successCriteria.join('\n')).toContain('watchers.create receipt');
      expect(watcher?.outcome?.evidenceFields).toContain('lastError');
      expect(watcher?.outcome?.verificationRoute).toContain('watchers.list');
      const watcherContract = watcher?.evidenceContract;
      expect(watcherContract?.status).toBe('contract-needed');
      expect(watcherContract?.owner).toBe('goodvibes-sdk-or-daemon');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'watcher-list-route')?.status).toBe('published-route');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'durable-run-history-records')?.status).toBe('missing');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'provider-source-records')?.status).toBe('missing');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'redacted-event-payloads')?.status).toBe('missing');
      expect(watcherContract?.contractChecklist.find((check) => check.id === 'queue-correlation-records')?.status).toBe('missing');
      expect(watcherContract?.receiptContract.appliesTo).toContain('watchers.create');
      expect(watcherContract?.receiptContract.requiredFields).toContain('runId');
      expect(watcherContract?.receiptContract.requiredFields).toContain('sourceId');
      expect(watcherContract?.receiptContract.requiredFields).toContain('sourceScope');
      expect(watcherContract?.receiptContract.requiredFields).toContain('lastCheckpoint');
      expect(watcherContract?.receiptContract.requiredFields).toContain('lastError');
      expect(watcherContract?.receiptContract.requiredFields).toContain('recoveryRoute');
      expect(watcherContract?.providerSourceContract.supportedSourceKinds).toContain('gmail');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('scope');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('filter');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('nextRoute');
      expect(watcherContract?.providerSourceContract.requiredFields).toContain('lastError');
      expect(watcherContract?.providerSourceContract.policy).toContain('never polls personal providers silently');
      expect(watcher?.policy).toContain('Incoming triggers are admin connected-host mutations');
      const gmail = trigger.triggerWorkflows.find((workflow) => workflow.id === 'gmail-or-email-trigger');
      expect(gmail?.status).toBe('attention');
      expect(gmail?.evidenceContract?.providerSourceContract.supportedSourceKinds).toContain('gmail');
      expect(gmail?.policy).toContain('does not poll or read mail silently');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a local-first execution posture before delegation', async () => {
    const fixture = makeFixture();
    try {
      for (const name of ['read', 'edit', 'exec', 'fetch', 'web_search']) registerStubTool(fixture.toolRegistry, name);

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly localFirstPolicy: string;
          readonly delegationPolicy: string;
          readonly browserControl: string;
          readonly executionHistory: string;
          readonly backgroundProcesses: string;
          readonly browserControlSetup: {
            readonly status: string;
            readonly setupRoute: string;
            readonly recommendedRoute: string;
            readonly toolMatches: readonly string[];
            readonly needsReview: boolean;
            readonly workflows: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string; readonly safety: string }[];
            readonly setupChecklist: readonly string[];
            readonly fallbackRoutes: readonly string[];
          };
          readonly sudoPosture: {
            readonly status: string;
            readonly setupRoute: string;
            readonly credentialSignal: {
              readonly checked: string;
              readonly rawValueReturned: boolean;
              readonly valueUsableForBackgroundProcess: boolean;
            };
            readonly blockedRoutes: readonly { readonly id: string }[];
          };
          readonly supervision: {
            readonly processMonitorAvailable: boolean;
            readonly liveTailAvailable: boolean;
            readonly toolInspectorAvailable: boolean;
          };
          readonly delegationDecisionCards: readonly { readonly lane: string }[];
          readonly registeredExecutionTools: readonly string[];
        };
        readonly decisionRules: readonly string[];
        readonly routes: readonly {
          readonly executionRouteId: string;
          readonly availability: string;
          readonly modelRoute: string;
          readonly nextStep?: string;
          readonly recoveryRoute?: string;
          readonly supervisionRoutes?: readonly {
            readonly id: string;
            readonly available: boolean;
            readonly modelRoute: string;
          }[];
        }[];
      }>(fixture, {
        mode: 'execution_posture',
        includeParameters: true,
      });
      expect(posture.summary.localFirstPolicy).toContain('Use local read/edit/exec');
      expect(posture.summary.delegationPolicy).toContain('isolation');
      expect(posture.summary.backgroundProcesses).toContain('execution action:"processes"');
      expect(posture.summary.browserControl).toBe('setup-needed');
      expect(posture.summary.executionHistory).toContain('execution action:"history"');
      expect(posture.summary.browserControlSetup.setupRoute).toContain('browser-desktop-control');
      expect(posture.summary.browserControlSetup.recommendedRoute).toContain('mcp_servers');
      expect(posture.summary.browserControlSetup.needsReview).toBe(false);
      expect(posture.summary.browserControlSetup.workflows[0]?.id).toBe('browser-navigation');
      expect(posture.summary.browserControlSetup.workflows[0]?.status).toBe('setup-needed');
      expect(posture.summary.browserControlSetup.workflows[0]?.inspectRoute).toContain('setup action:"item"');
      expect(posture.summary.browserControlSetup.setupChecklist.join('\n')).toContain('constrained trust');
      expect(posture.summary.browserControlSetup.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(posture.summary.sudoPosture.status).toContain('foreground');
      expect(posture.summary.sudoPosture.setupRoute).toContain('sudo-execution-posture');
      expect(posture.summary.sudoPosture.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(posture.summary.sudoPosture.credentialSignal.rawValueReturned).toBe(false);
      expect(posture.summary.sudoPosture.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(posture.summary.sudoPosture.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');
      expect(posture.summary.supervision.processMonitorAvailable).toBe(true);
      expect(posture.summary.supervision.liveTailAvailable).toBe(true);
      expect(posture.summary.registeredExecutionTools).toEqual(expect.arrayContaining(['read', 'edit', 'exec', 'fetch', 'web_search']));
      expect(posture.decisionRules.join('\n')).toContain('Do not delegate ordinary local implementation');

      const shell = posture.routes.find((route) => route.executionRouteId === 'local-shell-command');
      expect(shell?.availability).toBe('ready');
      expect(shell?.modelRoute).toBe('exec');
      expect(shell?.supervisionRoutes?.map((route) => route.id)).toEqual(expect.arrayContaining(['process-monitor', 'live-tail']));
      expect(shell?.supervisionRoutes?.find((route) => route.id === 'process-monitor')?.available).toBe(true);
      expect(shell?.supervisionRoutes?.find((route) => route.id === 'live-tail')?.modelRoute).toContain('workspace action:"open"');

      const edit = posture.routes.find((route) => route.executionRouteId === 'local-edit-write');
      expect(edit?.availability).toBe('ready');
      expect(edit?.modelRoute).toBe('edit/write');
      expect(edit?.recoveryRoute).toContain('execution action:"recovery"');

      const browser = posture.routes.find((route) => route.executionRouteId === 'browser-or-desktop-control');
      expect(browser?.availability).toBe('setup-needed');

      const inspectedBrowser = await executeHarnessJson<{
        readonly executionRouteId: string;
        readonly availability: string;
        readonly browserControl?: {
          readonly status: string;
          readonly workflows: readonly { readonly id: string; readonly status: string; readonly setupRoute: string }[];
          readonly policy: string;
        };
      }>(fixture, {
        mode: 'execution_route',
        executionRouteId: 'browser-or-desktop-control',
      });
      expect(inspectedBrowser.executionRouteId).toBe('browser-or-desktop-control');
      expect(inspectedBrowser.availability).toBe('setup-needed');
      expect(inspectedBrowser.browserControl?.workflows[0]?.status).toBe('setup-needed');
      expect(inspectedBrowser.browserControl?.workflows[0]?.setupRoute).toContain('browser-desktop-control');
      expect(inspectedBrowser.browserControl?.policy).toContain('no live UI control is assumed');

      const setupNeededPlan = await executeHarnessJson<{
        readonly mode: string;
        readonly status: string;
        readonly workflow: { readonly id: string; readonly status: string };
        readonly decision: { readonly status: string; readonly modelRoute: string };
        readonly fallbackRoutes: readonly string[];
        readonly policy: { readonly boundary: string };
      }>(fixture, {
        mode: 'browser_control_route',
        query: 'take a screenshot of the dashboard',
        includeParameters: true,
      });
      expect(setupNeededPlan.mode).toBe('browser_control_route');
      expect(setupNeededPlan.status).toBe('setup-needed');
      expect(setupNeededPlan.workflow.id).toBe('screenshot-observation');
      expect(setupNeededPlan.workflow.status).toBe('setup-needed');
      expect(setupNeededPlan.decision.status).toBe('setup-needed');
      expect(setupNeededPlan.decision.modelRoute).toContain('browser-desktop-control');
      expect(setupNeededPlan.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(setupNeededPlan.policy.boundary).toContain('never opens');

      const mcpApi = fixture.context.clients?.mcpApi as {
        listServerSecurity: () => readonly unknown[];
      };
      mcpApi.listServerSecurity = () => [{
        name: 'browser-stale',
        connected: true,
        trustMode: 'blocked',
        role: 'browser',
        schemaFreshness: 'stale',
        quarantineReason: null,
        quarantineDetail: null,
        allowedPaths: [],
        allowedHosts: ['browser.example.test'],
      }];
      const attentionPosture = await executeHarnessJson<{
        readonly summary: {
          readonly browserControl: string;
          readonly browserControlSetup: {
            readonly configured: boolean;
            readonly needsReview: boolean;
            readonly mcpServers: readonly { readonly name: string; readonly readiness: string }[];
            readonly workflows: readonly { readonly status: string; readonly inspectRoute: string }[];
          };
        };
      }>(fixture, { mode: 'execution_posture' });
      expect(attentionPosture.summary.browserControl).toBe('attention');
      expect(attentionPosture.summary.browserControlSetup.configured).toBe(false);
      expect(attentionPosture.summary.browserControlSetup.needsReview).toBe(true);
      expect(attentionPosture.summary.browserControlSetup.mcpServers[0]?.readiness).toBe('attention');
      expect(attentionPosture.summary.browserControlSetup.workflows[0]?.status).toBe('attention');

      const attentionPlan = await executeHarnessJson<{
        readonly status: string;
        readonly workflow: { readonly id: string; readonly status: string };
        readonly decision: { readonly id: string; readonly status: string; readonly modelRoute: string };
        readonly mcpCandidates: readonly { readonly serverName: string; readonly readiness: string; readonly inspectRoute: string }[];
      }>(fixture, { mode: 'browser_control_route', query: 'navigate browser to a logged-in page' });
      expect(attentionPlan.status).toBe('attention');
      expect(attentionPlan.workflow.id).toBe('browser-navigation');
      expect(attentionPlan.workflow.status).toBe('attention');
      expect(attentionPlan.decision.id).toBe('review-browser-control-connector');
      expect(attentionPlan.decision.status).toBe('review-connector-first');
      expect(attentionPlan.decision.modelRoute).toContain('mcp_server');
      expect(attentionPlan.mcpCandidates[0]?.serverName).toBe('browser-stale');
      expect(attentionPlan.mcpCandidates[0]?.readiness).toBe('attention');

      const attentionBrowserSetup = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(attentionBrowserSetup.setupItemId).toBe('browser-desktop-control');
      expect(attentionBrowserSetup.status).toBe('check');
      expect(attentionBrowserSetup.signals?.join('\n')).toContain('attention');

      // A tool merely NAMED like a browser tool must not change the posture:
      // capability comes from what a tool declares and what can be invoked,
      // never from what its name or description happens to say.
      registerStubTool(fixture.toolRegistry, 'browser_screenshot');
      const namedOnlyPosture = await executeHarnessJson<{
        readonly summary: { readonly browserControl: string };
      }>(fixture, { mode: 'execution_posture' });
      expect(namedOnlyPosture.summary.browserControl).not.toBe('ready');

      const browserRoot = makeProjectTempDir('goodvibes-harness-browser');
      registerAgentBrowserTool(fixture.toolRegistry, {
        screenshotDirectory: join(browserRoot, 'shots'),
        profileRoot: join(browserRoot, 'profiles'),
        homeDirectory: join(browserRoot, 'home'),
      });
      const configuredPosture = await executeHarnessJson<{
        readonly summary: {
          readonly browserControl: string;
          readonly browserControlSetup: {
            readonly declaredControlTools: readonly string[];
            readonly recommendedRoute: string;
            readonly workflows: readonly { readonly status: string; readonly inspectRoute: string }[];
          };
        };
        readonly routes: readonly {
          readonly executionRouteId: string;
          readonly availability: string;
        }[];
      }>(fixture, { mode: 'execution_posture' });
      expect(configuredPosture.summary.browserControl).toBe('ready');
      expect(configuredPosture.summary.browserControlSetup.declaredControlTools).toEqual(['browser']);
      expect(configuredPosture.summary.browserControlSetup.recommendedRoute).toContain('browser action:');
      expect(configuredPosture.summary.browserControlSetup.workflows[0]?.status).toBe('ready');
      expect(configuredPosture.summary.browserControlSetup.workflows[0]?.inspectRoute).toContain('browser action:');
      expect(configuredPosture.routes.find((route) => route.executionRouteId === 'browser-or-desktop-control')?.availability).toBe('ready');

      const configuredPlan = await executeHarnessJson<{
        readonly status: string;
        readonly workflow: { readonly id: string; readonly status: string };
        readonly decision: { readonly id: string; readonly status: string; readonly modelRoute: string; readonly nextStep: string };
        readonly toolCandidates: readonly { readonly toolName: string; readonly inspectRoute: string }[];
        readonly policy: { readonly confirmation: string };
      }>(fixture, { mode: 'browser_control_route', query: 'take screenshot of the browser page' });
      expect(configuredPlan.status).toBe('ready');
      expect(configuredPlan.workflow.id).toBe('screenshot-observation');
      expect(configuredPlan.workflow.status).toBe('ready');
      expect(configuredPlan.decision.id).toBe('inspect-configured-browser-control');
      expect(configuredPlan.decision.status).toBe('ready-to-inspect-tool');
      expect(configuredPlan.decision.modelRoute).toContain('browser action:');
      expect(configuredPlan.decision.nextStep).toContain('Call browser action:');
      expect(configuredPlan.toolCandidates[0]?.toolName).toBe('browser');
      expect(configuredPlan.toolCandidates[0]?.inspectRoute).toContain('mode:"tool"');
      expect(configuredPlan.policy.confirmation).toContain('tool-specific confirmation');

      const configuredBrowserSetup = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly status: string;
        readonly modelRoute: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(configuredBrowserSetup.setupItemId).toBe('browser-desktop-control');
      expect(configuredBrowserSetup.status).toBe('ready');
      expect(configuredBrowserSetup.modelRoute).toContain('browser action:');
      expect(configuredBrowserSetup.signals?.join('\n')).toContain('browser');

      const delegated = posture.routes.find((route) => route.executionRouteId === 'delegation-isolation-parallel-remote');
      expect(delegated?.availability).toBe('ready');
      expect(delegated?.nextStep).toContain('delegation action:"status"');
      expect(posture.summary.delegationDecisionCards.map((card) => card.lane)).toEqual(expect.arrayContaining([
        'local-first',
        'tui-shared-session',
        'delegated-review',
        'remote-runner',
        'hidden-fanout-blocked',
      ]));

      const inspectedShell = await executeHarnessJson<{
        readonly executionRouteId: string;
        readonly availability: string;
        readonly safety: string;
        readonly useInsteadWhen?: string;
      }>(fixture, {
        mode: 'execution_route',
        executionRouteId: 'local-shell-command',
      });
      expect(inspectedShell.executionRouteId).toBe('local-shell-command');
      expect(inspectedShell.availability).toBe('ready');
      expect(inspectedShell.safety).toContain('foreground serial');
      expect(inspectedShell.safety).toContain('sudo');
      expect(inspectedShell.useInsteadWhen).toContain('execution action:"processes"');

      const inspectedDelegation = await executeHarnessJson<{
        readonly executionRouteId: string;
        readonly preferredWhen: string;
        readonly useInsteadWhen?: string;
        readonly delegationDecisionCards?: readonly {
          readonly id: string;
          readonly lane: string;
          readonly requiredFields: readonly string[];
          readonly confirmationBoundary: string;
        }[];
      }>(fixture, {
        mode: 'execution_route',
        executionRouteId: 'delegation-isolation-parallel-remote',
      });
      expect(inspectedDelegation.preferredWhen).toContain('remote host');
      expect(inspectedDelegation.useInsteadWhen).toContain('Use local read/edit/exec');
      expect(inspectedDelegation.delegationDecisionCards?.find((card) => card.lane === 'tui-shared-session')?.requiredFields.join('\n')).toContain('delegation reason');
      expect(inspectedDelegation.delegationDecisionCards?.find((card) => card.lane === 'hidden-fanout-blocked')?.confirmationBoundary).toContain('never confirmed');
    } finally {
      fixture.cleanup();
    }
  });

  test('consumes certified daemon interactive runtime records for process PTY sudo and browser control posture', async () => {
    const fixture = makeFixture();
    try {
      for (const name of ['read', 'edit', 'exec']) registerStubTool(fixture.toolRegistry, name);
      const readModels = (fixture.context.platform as unknown as { readModels: Record<string, unknown> }).readModels;
      readModels.execution = {
        interactiveRuntime: {
          getSnapshot: () => ({
            processes: [{
              kind: 'process-output',
              id: 'runtime-process-1',
              processId: 'host-proc-1',
              pid: 4321,
              status: 'running',
              command: 'npm run dev --token=host-secret',
              outputChunks: [{
                chunkId: 'chunk-1',
                stream: 'stdout',
                text: 'server ready token=chunk-secret',
                bytes: 31,
                truncated: false,
                createdAt: '2026-06-08T12:00:00.000Z',
              }],
              routes: {
                inspect: 'execution action:"process" processId:"host-proc-1" includeParameters:true',
                log: 'process action:"log" processId:"host-proc-1"',
                write: 'process action:"write" processId:"host-proc-1" data:"..." confirm:true explicitUserRequest:"..."',
                kill: 'process action:"kill" processId:"host-proc-1" confirm:true explicitUserRequest:"..."',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.execution.process.v1',
              publicationGuarantee: 'daemon publishes live process chunks token=process-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method processes.list', 'sourceTool execution.processRuntime'],
              updatedAt: '2026-06-08T12:00:00.000Z',
            }],
            ptySessions: [{
              kind: 'pty-session',
              id: 'pty-session-1',
              sessionId: 'pty-session-1',
              status: 'ready',
              command: 'python',
              outputChunks: [{ chunkId: 'pty-chunk-1', stream: 'stdout', text: '>>>', truncated: false }],
              routes: {
                inspect: 'agent_operator_method methodId:"terminal.sessions.get" sessionId:"pty-session-1"',
                input: 'agent_operator_method methodId:"terminal.sessions.input" sessionId:"pty-session-1" confirm:true explicitUserRequest:"..."',
                output: 'agent_operator_method methodId:"terminal.sessions.output" sessionId:"pty-session-1"',
                close: 'agent_operator_method methodId:"terminal.sessions.close" sessionId:"pty-session-1" confirm:true explicitUserRequest:"..."',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.execution.pty-session.v1',
              publicationGuarantee: 'daemon publishes typed PTY sessions secret=pty-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method terminal.sessions.list', 'sourceTool terminal.sessions'],
              updatedAt: '2026-06-08T12:00:01.000Z',
            }],
            sudoMediation: [{
              kind: 'sudo-mediation',
              id: 'sudo-contract-1',
              status: 'ready',
              rawSecretReturned: false,
              routes: {
                inspect: 'agent_operator_method methodId:"credentials.sudo.status"',
                credential: 'agent_operator_method methodId:"credentials.sudo.prompt" confirm:true explicitUserRequest:"..."',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.execution.sudo-mediation.v1',
              publicationGuarantee: 'daemon mediates sudo prompts password=sudo-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method credentials.sudo.status', 'sourceTool credential-mediation'],
              updatedAt: '2026-06-08T12:00:02.000Z',
            }],
          }),
        },
      };
      readModels.computer = {
        browserDesktopReceipts: {
          getSnapshot: () => ({
            receipts: [{
              kind: 'browser-desktop-receipt',
              id: 'browser-receipt-1',
              receiptId: 'browser-command-1',
              action: 'screenshot',
              surface: 'browser',
              status: 'succeeded',
              summary: 'Captured browser page secret=browser-secret',
              routes: {
                inspect: 'computer action:"control" includeParameters:true',
                execute: 'agent_operator_method methodId:"browser.control.execute" confirm:true explicitUserRequest:"..."',
                receipt: 'agent_operator_method methodId:"browser.control.receipts"',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.computer.browser-control-receipt.v1',
              publicationGuarantee: 'daemon publishes browser control receipts token=browser-token',
              publisher: 'goodvibes-daemon',
              provenance: ['method browser.control.receipts', 'sourceTool browser.control'],
              updatedAt: '2026-06-08T12:00:03.000Z',
            }],
          }),
        },
      };

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly browserControl: string;
          readonly browserControlSetup: {
            readonly status: string;
            readonly recommendedRoute: string;
            readonly certifiedRuntimeRecords: readonly {
              readonly receiptId?: string;
              readonly certification: { readonly schemaStatus: string; readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] };
            }[];
          };
          readonly interactiveRuntime: {
            readonly status: string;
            readonly certifiedRecordCount: number;
            readonly liveProcessOutput: { readonly status: string; readonly latest?: { readonly outputChunks?: readonly { readonly text: string }[]; readonly certification: { readonly missingSignals: readonly string[] } } };
            readonly ptySessions: { readonly status: string };
            readonly sudoMediation: { readonly status: string };
            readonly browserDesktopControl: { readonly status: string };
          };
        };
        readonly routes: readonly { readonly executionRouteId: string; readonly availability: string }[];
        readonly decisionRules: readonly string[];
      }>(fixture, { mode: 'execution_posture', includeParameters: true });
      expect(posture.summary.interactiveRuntime.status).toBe('certified-live-runtime');
      expect(posture.summary.interactiveRuntime.certifiedRecordCount).toBe(4);
      expect(posture.summary.interactiveRuntime.liveProcessOutput.status).toBe('certified');
      expect(posture.summary.interactiveRuntime.liveProcessOutput.latest?.outputChunks?.[0]?.text).toContain('token=<redacted>');
      expect(posture.summary.interactiveRuntime.liveProcessOutput.latest?.certification.missingSignals).toEqual([]);
      expect(posture.summary.interactiveRuntime.ptySessions.status).toBe('certified');
      expect(posture.summary.interactiveRuntime.sudoMediation.status).toBe('certified');
      expect(posture.summary.interactiveRuntime.browserDesktopControl.status).toBe('certified');
      expect(posture.summary.browserControl).toBe('ready');
      expect(posture.summary.browserControlSetup.recommendedRoute).toContain('browser.control.execute');
      expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.receiptId).toBe('browser-command-1');
      expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.certification.schemaStatus).toBe('certified');
      expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
      expect(posture.summary.browserControlSetup.certifiedRuntimeRecords[0]?.certification.missingSignals).toEqual([]);
      expect(posture.routes.find((route) => route.executionRouteId === 'browser-or-desktop-control')?.availability).toBe('ready');
      expect(posture.decisionRules.join('\n')).toContain('certified SDK/daemon runtime records');

      const plan = await executeHarnessJson<{
        readonly status: string;
        readonly decision: { readonly status: string; readonly modelRoute: string };
        readonly posture: { readonly certifiedRuntimeRecords: readonly { readonly id: string }[] };
      }>(fixture, { mode: 'browser_control_route', query: 'take a browser screenshot', includeParameters: true });
      expect(plan.status).toBe('ready');
      expect(plan.decision.status).toBe('ready-to-inspect-tool');
      expect(plan.decision.modelRoute).toContain('browser.control.execute');
      expect(plan.posture.certifiedRuntimeRecords[0]?.id).toBe('browser-receipt-1');

      const capabilities = await executeHarnessJson<{
        readonly capabilities: {
          readonly parity: readonly { readonly capability: string; readonly status: string }[];
          readonly interactiveRuntime: { readonly status: string; readonly certifiedRecordCount: number };
        };
      }>(fixture, { mode: 'run_background_process', processAction: 'capabilities' });
      expect(capabilities.capabilities.interactiveRuntime.status).toBe('certified-live-runtime');
      expect(capabilities.capabilities.interactiveRuntime.certifiedRecordCount).toBe(4);
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'process(write)')?.status).toBe('contract-discovered');
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'pty')?.status).toBe('contract-discovered');
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'sudo')?.status).toBe('contract-discovered');

      const setupItem = await executeHarnessJson<{
        readonly status: string;
        readonly signals?: readonly string[];
      }>(fixture, { mode: 'setup_item', setupItemId: 'browser-desktop-control' });
      expect(setupItem.status).toBe('ready');
      expect(setupItem.signals?.join('\n')).toContain('certified runtime receipts');
      expect(JSON.stringify({ posture, plan, capabilities, setupItem })).not.toContain('host-secret');
      expect(JSON.stringify({ posture, plan, capabilities, setupItem })).not.toContain('chunk-secret');
      expect(JSON.stringify({ posture, plan, capabilities, setupItem })).not.toContain('sudo-secret');
      expect(JSON.stringify({ posture, plan, capabilities, setupItem })).not.toContain('browser-token');
    } finally {
      fixture.cleanup();
    }
  });

  test('manages tracked background processes through confirmed harness routes', async () => {
    const fixture = makeFixture();
    try {
      const empty = await executeHarnessJson<{
        readonly status: string;
        readonly summary: { readonly tracked: number; readonly running: number };
        readonly capabilities: {
          readonly start: string;
          readonly parity: readonly { readonly capability: string; readonly status: string; readonly modelRoute: string }[];
          readonly substrate: {
            readonly localProcessManager: {
              readonly supports: readonly string[];
              readonly stdinWrite: { readonly status: string; readonly missingAnyOf?: readonly string[] };
            };
            readonly daemonOperatorContract: {
              readonly status: string;
              readonly sessionInputRoutes: readonly { readonly methodId: string; readonly modelRoute: string }[];
            };
            readonly auditedTerms: readonly string[];
          };
          readonly pty: { readonly status: string };
          readonly stdinWrite: { readonly status: string; readonly modelRoute: string };
          readonly sudo: {
            readonly status: string;
            readonly setupRoute: string;
            readonly credentialSignal: {
              readonly checked: string;
              readonly rawValueReturned: boolean;
              readonly valueUsableForBackgroundProcess: boolean;
            };
            readonly blockedRoutes: readonly { readonly id: string }[];
          };
        };
      }>(fixture, { mode: 'background_processes', includeParameters: true });
      expect(empty.status).toBe('available');
      expect(empty.summary.tracked).toBe(0);
      expect(empty.capabilities.start).toContain('terminal command');
      expect(empty.capabilities.parity.find((entry) => entry.capability === 'process(wait)')?.status).toBe('supported');
      expect(empty.capabilities.parity.find((entry) => entry.capability === 'process(write)')?.status).toBe('blocked-contract-gap');
      expect(empty.capabilities.substrate.localProcessManager.supports).toContain('spawn');
      expect(empty.capabilities.substrate.localProcessManager.stdinWrite.status).toBe('blocked-contract-gap');
      expect(empty.capabilities.substrate.localProcessManager.stdinWrite.missingAnyOf).toContain('writeInput');
      expect(empty.capabilities.substrate.daemonOperatorContract.status).toContain('no-published-terminal');
      expect(empty.capabilities.substrate.daemonOperatorContract.sessionInputRoutes.map((route) => route.methodId)).toContain('sessions.inputs.list');
      expect(empty.capabilities.substrate.auditedTerms).toContain('sessions.inputs');
      expect(empty.capabilities.pty.status).toContain('not-yet-supported');
      expect(empty.capabilities.stdinWrite.status).toContain('not-yet-supported');
      expect(empty.capabilities.stdinWrite.modelRoute).toContain('process action:"write"');
      expect(empty.capabilities.sudo.status).toContain('foreground');
      expect(empty.capabilities.sudo.setupRoute).toContain('sudo-execution-posture');
      expect(empty.capabilities.sudo.credentialSignal.checked).toContain('SUDO_PASSWORD');
      expect(empty.capabilities.sudo.credentialSignal.rawValueReturned).toBe(false);
      expect(empty.capabilities.sudo.credentialSignal.valueUsableForBackgroundProcess).toBe(false);
      expect(empty.capabilities.sudo.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_background_process',
        processAction: 'start',
        command: 'printf ready',
        explicitUserRequest: 'Run a quick tracked command.',
      });
      expect(unconfirmed.success).toBe(true);
      const unconfirmedResult = JSON.parse(unconfirmed.output ?? '{}') as { status: string; reason: string };
      expect(unconfirmedResult.status).toBe('needs_confirmation');
      expect(unconfirmedResult.reason).toContain('confirm:true');

      const started = await executeHarnessJson<{
        readonly status: string;
        readonly processId: string;
        readonly processSessionId: string;
        readonly sessionId: string;
        readonly session_id: string;
        readonly pid: number;
        readonly command: string;
        readonly routes: { readonly inspect: string; readonly poll: string; readonly log: string; readonly stop: string; readonly visibleMonitor: string };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'printf "hello"; printf "secret=abc123456" >&2',
        confirm: true,
        explicitUserRequest: 'Start a tracked background smoke command.',
      });
      expect(started.status).toBe('started');
      expect(started.processId).toMatch(/^bg_/);
      expect(started.processSessionId).toBe(started.processId);
      expect(started.sessionId).toBe(started.processId);
      expect(started.session_id).toBe(started.processId);
      expect(started.pid).toBeGreaterThan(0);
      expect(started.command).toContain('printf');
      expect(started.routes.inspect).toContain(started.processId);
      expect(started.routes.poll).toContain('process action:"poll"');
      expect(started.routes.log).toContain('process action:"log"');
      expect(started.routes.visibleMonitor).toContain('process-monitor');

      const waited = await executeHarnessJson<{
        readonly status: string;
        readonly process?: {
          readonly processId: string;
          readonly output?: {
            readonly stdoutTail: string;
            readonly stderrTail: string;
            readonly stdoutTruncated: boolean;
            readonly stderrTruncated: boolean;
            readonly fullOutputIncluded: boolean;
          };
        };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'wait',
        processId: started.processId,
        timeoutMs: 5000,
        confirm: true,
        explicitUserRequest: 'Wait for the tracked smoke command to finish.',
      });
      expect(waited.status).toBe('completed');
      expect(waited.process?.processId).toBe(started.processId);
      expect(waited.process?.output?.stdoutTail).toContain('hello');
      expect(waited.process?.output?.stderrTail).toContain('secret=<redacted>');
      expect(waited.process?.output?.stderrTail).not.toContain('abc123456');
      expect(waited.process?.output?.stdoutTruncated).toBe(false);
      expect(waited.process?.output?.stderrTruncated).toBe(false);
      expect(waited.process?.output?.fullOutputIncluded).toBe(true);

      const inspected = await executeHarnessJson<{
        readonly processId: string;
        readonly sessionId: string;
        readonly session_id: string;
        readonly status: string;
        readonly routes: { readonly log: string };
        readonly output?: { readonly stdoutTail: string; readonly stderrTail: string; readonly stdoutBytes: number; readonly stderrBytes: number; readonly maxOutputChars: number; readonly policy: string };
      }>(fixture, {
        mode: 'background_process',
        session_id: started.session_id,
      });
      expect(inspected.processId).toBe(started.processId);
      expect(inspected.sessionId).toBe(started.processId);
      expect(inspected.session_id).toBe(started.processId);
      expect(inspected.status).toBe('succeeded');
      expect(inspected.routes.log).toContain('process action:"log"');
      expect(inspected.output?.policy).toContain('redacted');
      expect(inspected.output?.stdoutBytes).toBeGreaterThan(0);
      expect(inspected.output?.stderrBytes).toBeGreaterThan(0);
      expect(inspected.output?.maxOutputChars).toBeGreaterThan(0);

      const polled = await executeHarnessJson<{
        readonly processId: string;
        readonly status: string;
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'poll',
        sessionId: started.sessionId,
      });
      expect(polled.processId).toBe(started.processId);
      expect(polled.status).toBe('succeeded');

      const logged = await executeHarnessJson<{
        readonly processId: string;
        readonly output?: { readonly stdoutTail: string; readonly stdoutTruncated: boolean; readonly fullOutputIncluded: boolean };
      }>(fixture, {
        mode: 'run_background_process',
        action: 'log',
        processSessionId: started.processSessionId,
      });
      expect(logged.processId).toBe(started.processId);
      expect(logged.output?.stdoutTail).toContain('hello');
      expect(logged.output?.stdoutTruncated).toBe(false);
      expect(logged.output?.fullOutputIncluded).toBe(true);

      const longStarted = await executeHarnessJson<{ readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'printf "%05000d" 0',
        confirm: true,
        explicitUserRequest: 'Start a tracked long-output smoke command.',
      });
      await executeHarnessJson(fixture, {
        mode: 'run_background_process',
        processAction: 'wait',
        processId: longStarted.processId,
        timeoutMs: 5000,
        confirm: true,
        explicitUserRequest: 'Wait for the tracked long-output smoke command.',
      });
      const longLogged = await executeHarnessJson<{
        readonly output?: {
          readonly stdoutTail: string;
          readonly stdoutChars: number;
          readonly stdoutTruncated: boolean;
          readonly omittedStdoutChars: number;
          readonly maxOutputChars: number;
          readonly fullOutputIncluded: boolean;
        };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'log',
        processId: longStarted.processId,
      });
      expect(longLogged.output?.stdoutChars).toBe(5000);
      expect(longLogged.output?.stdoutTail.length).toBeLessThanOrEqual(longLogged.output?.maxOutputChars ?? 0);
      expect(longLogged.output?.stdoutTruncated).toBe(true);
      expect(longLogged.output?.omittedStdoutChars).toBeGreaterThan(0);
      expect(longLogged.output?.fullOutputIncluded).toBe(false);

      const longStopped = await executeHarnessJson<{ readonly status: string; readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'kill',
        processId: longStarted.processId,
        confirm: true,
        explicitUserRequest: 'Remove the tracked long-output smoke command.',
      });
      expect(longStopped.status).toBe('stopped');
      expect(longStopped.processId).toBe(longStarted.processId);

      const stopped = await executeHarnessJson<{ readonly status: string; readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'kill',
        sessionId: started.sessionId,
        confirm: true,
        explicitUserRequest: 'Remove the tracked completed smoke command.',
      });
      expect(stopped.status).toBe('stopped');
      expect(stopped.processId).toBe(started.processId);
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes terminal and process adapters for tracked background process UX', async () => {
    const fixture = makeFixture();
    try {
      const foreground = await fixture.toolRegistry.execute('terminal-foreground', 'terminal', {
        command: 'printf "foreground"',
      });
      expect(foreground.success).toBe(false);
      expect(foreground.error).toContain('background:true');

      const started = await fixture.toolRegistry.execute('terminal-start', 'terminal', {
        command: 'printf "adapter-output"',
        background: true,
        confirm: true,
        explicitUserRequest: 'Start a tracked adapter smoke command.',
      });
      expect(started.success).toBe(true);
      if (!started.success) throw new Error(started.error);
      const startedJson = JSON.parse(started.output ?? '{}') as {
        readonly status: string;
        readonly processId: string;
        readonly session_id: string;
        readonly routes: { readonly log: string; readonly poll: string; readonly stop: string };
      };
      expect(startedJson.status).toBe('started');
      expect(startedJson.processId).toMatch(/^bg_/);
      expect(startedJson.routes.log).toContain('process action:"log"');
      expect(startedJson.routes.poll).toContain('process action:"poll"');

      const waited = await fixture.toolRegistry.execute('process-wait', 'process', {
        action: 'wait',
        session_id: startedJson.session_id,
        timeoutMs: 5000,
        confirm: true,
        explicitUserRequest: 'Wait for the tracked adapter smoke command.',
      });
      expect(waited.success).toBe(true);
      if (!waited.success) throw new Error(waited.error);
      const waitedJson = JSON.parse(waited.output ?? '{}') as { readonly status: string };
      expect(waitedJson.status).toBe('completed');

      const logged = await fixture.toolRegistry.execute('process-log', 'process', {
        action: 'log',
        sessionId: startedJson.processId,
      });
      expect(logged.success).toBe(true);
      if (!logged.success) throw new Error(logged.error);
      const loggedJson = JSON.parse(logged.output ?? '{}') as {
        readonly processId: string;
        readonly output?: { readonly stdoutTail: string; readonly stdoutTruncated: boolean; readonly fullOutputIncluded: boolean };
      };
      expect(loggedJson.processId).toBe(startedJson.processId);
      expect(loggedJson.output?.stdoutTail).toContain('adapter-output');
      expect(loggedJson.output?.stdoutTruncated).toBe(false);
      expect(loggedJson.output?.fullOutputIncluded).toBe(true);

      const listed = await fixture.toolRegistry.execute('process-list', 'process', { action: 'list' });
      expect(listed.success).toBe(true);
      if (!listed.success) throw new Error(listed.error);
      expect(listed.output).toContain(startedJson.processId);

      const terminalTool = await fixture.tool.execute({ mode: 'tool', toolName: 'terminal' });
      expect(terminalTool.success).toBe(true);
      if (!terminalTool.success) throw new Error(terminalTool.error);
      expect(terminalTool.output).toContain('"name": "terminal"');
      expect(terminalTool.output).toContain('"background"');

      const processTool = await fixture.tool.execute({ mode: 'tool', toolName: 'process' });
      expect(processTool.success).toBe(true);
      if (!processTool.success) throw new Error(processTool.error);
      expect(processTool.output).toContain('"name": "process"');
      expect(processTool.output).toContain('"action"');

      const stopped = await fixture.toolRegistry.execute('process-kill', 'process', {
        action: 'kill',
        processId: startedJson.processId,
        confirm: true,
        explicitUserRequest: 'Remove the tracked adapter smoke command.',
      });
      expect(stopped.success).toBe(true);
      if (!stopped.success) throw new Error(stopped.error);
      const stoppedJson = JSON.parse(stopped.output ?? '{}') as { readonly status: string; readonly processId: string };
      expect(stoppedJson.status).toBe('stopped');
      expect(stoppedJson.processId).toBe(startedJson.processId);
    } finally {
      fixture.cleanup();
    }
  });

  test('reports unsupported PTY/stdin and blocks background sudo prompts', async () => {
    const fixture = makeFixture();
    try {
      const pty = await executeHarnessJson<{ readonly status: string; readonly capability: string; readonly guidance: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'python',
        pty: true,
      });
      expect(pty.status).toBe('unsupported');
      expect(pty.capability).toBe('pty');
      expect(pty.guidance).toContain('Interactive PTY');

      const write = await executeHarnessJson<{ readonly status: string; readonly usage: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'status',
        processId: 'bg_missing',
        data: 'y\n',
      });
      expect(write.status).toBe('missing_lookup');
      expect(write.usage).toContain('Unknown background process bg_missing');

      const writeAction = await executeHarnessJson<{ readonly status: string; readonly capability: string; readonly processId: string | null }>(fixture, {
        mode: 'run_background_process',
        processAction: 'write',
        sessionId: 'bg_missing',
        data: 'y\n',
        confirm: true,
        explicitUserRequest: 'Send y to the process.',
      });
      expect(writeAction.status).toBe('unsupported');
      expect(writeAction.capability).toBe('stdinWrite');
      expect(writeAction.processId).toBe('bg_missing');

      const unconfirmedWrite = await fixture.tool.execute({
        mode: 'run_background_process',
        processAction: 'write',
        sessionId: 'bg_missing',
        data: 'y\n',
        explicitUserRequest: 'Send y to the process.',
      });
      expect(unconfirmedWrite.success).toBe(true);
      const unconfirmedWriteResult = JSON.parse(unconfirmedWrite.output ?? '{}') as { status: string; reason: string };
      expect(unconfirmedWriteResult.status).toBe('needs_confirmation');
      expect(unconfirmedWriteResult.reason).toContain('confirm:true');

      const sudo = await executeHarnessJson<{
        readonly status: string;
        readonly capability: string;
        readonly reason: string;
        readonly guidance: {
          readonly setupRoute: string;
          readonly credentialSignal: { readonly rawValueReturned: boolean };
          readonly blockedRoutes: readonly { readonly id: string }[];
        };
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'sudo true',
        confirm: true,
        explicitUserRequest: 'Try a sudo background command.',
      });
      expect(sudo.status).toBe('blocked');
      expect(sudo.capability).toBe('sudo');
      expect(sudo.reason).toContain('Background sudo prompts');
      expect(sudo.guidance.setupRoute).toContain('sudo-execution-posture');
      expect(sudo.guidance.credentialSignal.rawValueReturned).toBe(false);
      expect(sudo.guidance.blockedRoutes.map((route) => route.id)).toContain('background-sudo-prompt');

      const capabilities = await executeHarnessJson<{
        readonly status: string;
        readonly capabilities: {
          readonly parity: readonly { readonly capability: string; readonly status: string }[];
          readonly sudo: { readonly setupRoute: string; readonly credentialSignal: { readonly rawValueReturned: boolean } };
        };
        readonly policy: string;
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'capabilities',
      });
      expect(capabilities.status).toBe('available');
      expect(capabilities.capabilities.parity.map((entry) => entry.capability)).toContain('terminal(background=true)');
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'pty')?.status).toBe('blocked-contract-gap');
      expect(capabilities.capabilities.sudo.setupRoute).toContain('sudo-execution-posture');
      expect(capabilities.capabilities.sudo.credentialSignal.rawValueReturned).toBe(false);
      expect(capabilities.policy).toContain('read-only');
    } finally {
      fixture.cleanup();
    }
  });

  test('uses a discovered ProcessManager stdin method only after confirmation', async () => {
    const fixture = makeFixture();
    const writes: Array<{ readonly processId: string; readonly data: string }> = [];
    try {
      const started = await executeHarnessJson<{ readonly processId: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'start',
        command: 'sleep 5',
        confirm: true,
        explicitUserRequest: 'Start a process that can receive input.',
      });
      Object.assign(fixture.processManager, {
        writeInput: (processId: string, data: string) => {
          writes.push({ processId, data });
          return { ok: true, echoed: data, secret: 'TOKEN=hidden' };
        },
      });

      const capabilities = await executeHarnessJson<{
        readonly capabilities: {
          readonly parity: readonly { readonly capability: string; readonly status: string }[];
          readonly stdinWrite: { readonly status: string; readonly guidance: string };
          readonly substrate: { readonly localProcessManager: { readonly stdinWrite: { readonly method: string; readonly executableByHarness: boolean } } };
        };
      }>(fixture, { mode: 'run_background_process', processAction: 'capabilities' });
      expect(capabilities.capabilities.parity.find((entry) => entry.capability === 'process(write)')?.status).toBe('contract-discovered');
      expect(capabilities.capabilities.stdinWrite.status).toBe('supported-with-confirmation');
      expect(capabilities.capabilities.stdinWrite.guidance).toContain('confirm:true');
      expect(capabilities.capabilities.substrate.localProcessManager.stdinWrite.method).toBe('writeInput');
      expect(capabilities.capabilities.substrate.localProcessManager.stdinWrite.executableByHarness).toBe(true);

      const wrote = await executeHarnessJson<{
        readonly status: string;
        readonly capability: string;
        readonly processId: string;
        readonly bytes: number;
        readonly result: { readonly returned: boolean; readonly preview: string; readonly inputEchoRedacted: boolean; readonly policy: string };
        readonly policy: string;
      }>(fixture, {
        mode: 'run_background_process',
        processAction: 'write',
        processId: started.processId,
        data: 'yes\n',
        confirm: true,
        explicitUserRequest: 'Send yes to the running process.',
      });
      expect(wrote.status).toBe('written');
      expect(wrote.capability).toBe('stdinWrite');
      expect(wrote.processId).toBe(started.processId);
      expect(wrote.bytes).toBe(4);
      expect(writes).toEqual([{ processId: started.processId, data: 'yes\n' }]);
      expect(wrote.result.returned).toBe(true);
      expect(wrote.result.preview).toContain('TOKEN=<redacted>');
      expect(wrote.result.preview).toContain('<redacted-input>');
      expect(wrote.result.preview).not.toContain('hidden');
      expect(wrote.result.preview).not.toContain('yes');
      expect(wrote.result.inputEchoRedacted).toBe(true);
      expect(wrote.result.policy).toContain('bounded');
      expect(wrote.policy).toContain('not echoed');

      const stopped = await executeHarnessJson<{ readonly status: string }>(fixture, {
        mode: 'run_background_process',
        processAction: 'kill',
        processId: started.processId,
        confirm: true,
        explicitUserRequest: 'Stop the stdin-capable test process.',
      });
      expect(stopped.status).toBe('stopped');
    } finally {
      fixture.cleanup();
    }
  });
  test('exposes local execution history records with supervision and recovery routes', async () => {
    const fixture = makeFixture();
    try {
      const now = Date.now();
      const target = join(fixture.root, 'history-edit.txt');
      writeFileSync(target, 'after', 'utf-8');
      fixture.context.workspace.fileUndoManager?.snapshot({
        path: target,
        beforeContent: 'before',
        afterContent: 'after',
        tool: 'edit',
      });
      fixture.executionRecords.push(
        {
          id: 'call-shell',
          callId: 'call-shell',
          turnId: 'turn-1',
          tool: 'exec',
          routeKind: 'shell',
          status: 'succeeded',
          phase: 'TOOL_SUCCEEDED',
          receivedAt: now - 2000,
          updatedAt: now - 1000,
          completedAt: now - 1000,
          durationMs: 1000,
          permissionApproved: true,
          argsPreview: '{"command":"bun test","apiKey":"[redacted]"}',
          argsKeys: ['command'],
          commandPreview: 'bun test src/test/tools/agent-harness-tool.test.ts',
          resultSummary: { kind: 'text', byteSize: 42, preview: '84 pass, 0 fail' },
        },
        {
          id: 'call-edit',
          callId: 'call-edit',
          turnId: 'turn-1',
          tool: 'edit',
          routeKind: 'write',
          status: 'succeeded',
          phase: 'TOOL_SUCCEEDED',
          receivedAt: now - 4000,
          updatedAt: now - 3000,
          completedAt: now - 3000,
          durationMs: 1000,
          argsPreview: '{"path":"history-edit.txt","content":"after"}',
          argsKeys: ['content', 'path'],
          targetPreview: 'history-edit.txt',
          resultSummary: { kind: 'json', byteSize: 18, preview: '{"ok":true}' },
        },
      );

      const summary = await executeHarnessJson<{
        readonly summary: {
          readonly records: number;
          readonly activityCards: number;
          readonly succeeded: number;
          readonly routeKinds: { readonly shell: number; readonly write: number };
        };
        readonly returnedActivityCards: number;
        readonly activityCards: readonly {
          readonly activityCardId: string;
          readonly title: string;
          readonly status: string;
          readonly outcome: string;
          readonly recordIds: readonly string[];
          readonly verification: {
            readonly status: string;
            readonly evidence: readonly { readonly executionRecordId: string; readonly outputPreview?: string }[];
          };
          readonly processOutput?: {
            readonly status: string;
            readonly evidence: readonly { readonly executionRecordId: string; readonly outputPreview?: string }[];
            readonly liveRoutes: readonly { readonly id: string }[];
          };
          readonly routes: {
            readonly fileRecovery?: string;
            readonly inspectLatest: string;
            readonly supervision: readonly { readonly id: string }[];
          };
          readonly nextAction: string;
        }[];
        readonly records: readonly {
          readonly executionRecordId: string;
          readonly tool: string;
          readonly routeKind: string;
          readonly commandPreview?: string;
          readonly argsPreview: string;
          readonly resultSummary?: { readonly preview?: string };
          readonly userCard?: {
            readonly activityCardId: string;
            readonly title: string;
            readonly verification: { readonly status: string };
          };
          readonly supervisionRoutes?: readonly { readonly id: string; readonly modelRoute: string }[];
          readonly recoveryRoute?: string;
        }[];
      }>(fixture, { mode: 'execution_history', includeParameters: true });
      expect(summary.summary.records).toBe(2);
      expect(summary.summary.activityCards).toBe(1);
      expect(summary.returnedActivityCards).toBe(1);
      expect(summary.summary.succeeded).toBe(2);
      expect(summary.summary.routeKinds.shell).toBe(1);
      expect(summary.summary.routeKinds.write).toBe(1);
      const card = summary.activityCards[0]!;
      expect(card.activityCardId).toBe('turn:turn-1');
      expect(card.title).toContain('bun test');
      expect(card.status).toBe('succeeded');
      expect(card.outcome).toContain('verification evidence');
      expect(card.recordIds).toEqual(['call-edit', 'call-shell']);
      expect(card.verification.status).toBe('passed');
      expect(card.verification.evidence.map((entry) => entry.executionRecordId)).toEqual(['call-shell']);
      expect(card.verification.evidence[0]?.outputPreview).toContain('84 pass');
      expect(card.processOutput?.status).toBe('bounded-summary-attached');
      expect(card.processOutput?.evidence[0]?.executionRecordId).toBe('call-shell');
      expect(card.processOutput?.liveRoutes.map((route) => route.id)).toEqual(['process-monitor', 'live-tail']);
      expect(card.routes.fileRecovery).toContain('execution action:"recovery"');
      expect(card.routes.inspectLatest).toContain('call-shell');
      expect(card.routes.supervision.map((route) => route.id)).toEqual(['process-monitor', 'live-tail']);
      expect(card.nextAction).toContain('No recovery action');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.commandPreview).toContain('bun test');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.argsPreview).toContain('[redacted]');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.resultSummary?.preview).toContain('84 pass');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.userCard?.activityCardId).toBe('record:call-shell');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.userCard?.verification.status).toBe('passed');
      expect(summary.records.find((record) => record.executionRecordId === 'call-shell')?.supervisionRoutes?.map((route) => route.id)).toEqual(expect.arrayContaining(['process-monitor', 'live-tail']));
      expect(summary.records.find((record) => record.executionRecordId === 'call-edit')?.recoveryRoute).toContain('execution action:"recovery"');

      const searched = await executeHarnessJson<{
        readonly returnedActivityCards: number;
        readonly activityCards: readonly { readonly recordIds: readonly string[]; readonly verification: { readonly status: string } }[];
        readonly records: readonly { readonly executionRecordId: string }[];
      }>(fixture, { mode: 'execution_history', query: 'bun test' });
      expect(searched.records.map((record) => record.executionRecordId)).toEqual(['call-shell']);
      expect(searched.returnedActivityCards).toBe(1);
      expect(searched.activityCards[0]?.recordIds).toEqual(['call-shell']);
      expect(searched.activityCards[0]?.verification.status).toBe('passed');

      const inspected = await executeHarnessJson<{
        readonly executionRecordId: string;
        readonly userCard?: { readonly activityCardId: string; readonly title: string };
        readonly policy?: { readonly effect: string; readonly values: string };
        readonly modelAccess?: { readonly toolInspector: string; readonly fileRecovery: string };
        readonly lookup?: { readonly resolvedBy?: string };
      }>(fixture, { mode: 'execution_history_item', executionRecordId: 'call-edit' });
      expect(inspected.executionRecordId).toBe('call-edit');
      expect(inspected.userCard?.activityCardId).toBe('record:call-edit');
      expect(inspected.userCard?.title).toContain('history-edit.txt');
      expect(inspected.lookup?.resolvedBy).toBe('id');
      expect(inspected.policy?.effect).toBe('read-only');
      expect(inspected.policy?.values).toContain('redacted args');
      expect(inspected.modelAccess?.fileRecovery).toContain('execution action:"recovery"');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes confirmed local file edit recovery from FileUndoManager snapshots', async () => {
    const fixture = makeFixture();
    try {
      const target = join(fixture.root, 'recoverable.txt');
      writeFileSync(target, 'after content', 'utf-8');
      fixture.context.workspace.fileUndoManager?.snapshot({
        path: target,
        beforeContent: 'before content',
        afterContent: 'after content',
        tool: 'edit',
      });

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly fileRecovery?: { readonly undoDepth: number; readonly redoDepth: number };
        };
      }>(fixture, { mode: 'execution_posture' });
      expect(posture.summary.fileRecovery?.undoDepth).toBe(1);
      expect(posture.summary.fileRecovery?.redoDepth).toBe(0);

      const recovery = await executeHarnessJson<{
        readonly status: string;
        readonly summary: {
          readonly undoDepth: number;
          readonly redoDepth: number;
          readonly nextUndo?: { readonly path: string; readonly tool: string };
        };
        readonly actions: readonly { readonly recoveryAction: string; readonly available: boolean; readonly modelRoute: string }[];
      }>(fixture, { mode: 'file_recovery', includeParameters: true });
      expect(recovery.status).toBe('available');
      expect(recovery.summary.undoDepth).toBe(1);
      expect(recovery.summary.redoDepth).toBe(0);
      expect(recovery.summary.nextUndo).toMatchObject({ path: 'recoverable.txt', tool: 'edit' });
      expect(recovery.actions.find((action) => action.recoveryAction === 'undo')?.available).toBe(true);
      expect(recovery.actions.find((action) => action.recoveryAction === 'undo')?.modelRoute).toBe('agent_harness mode:"run_file_recovery"');

      const denied = await fixture.tool.execute({ mode: 'run_file_recovery', recoveryAction: 'undo' });
      expect(denied.success).toBe(false);
      if (denied.success) throw new Error('run_file_recovery unexpectedly succeeded without confirmation');
      expect(denied.error).toContain('explicitUserRequest');

      const undo = await executeHarnessJson<{
        readonly status: string;
        readonly recoveryAction: string;
        readonly path: string;
        readonly tool: string;
        readonly summary: { readonly undoDepth: number; readonly redoDepth: number };
      }>(fixture, {
        mode: 'run_file_recovery',
        recoveryAction: 'undo',
        confirm: true,
        explicitUserRequest: 'Undo the last local file edit.',
      });
      expect(undo).toMatchObject({
        status: 'applied',
        recoveryAction: 'undo',
        path: 'recoverable.txt',
        tool: 'edit',
      });
      expect(readFileSync(target, 'utf-8')).toBe('before content');
      expect(undo.summary.undoDepth).toBe(0);
      expect(undo.summary.redoDepth).toBe(1);

      const redo = await executeHarnessJson<{
        readonly status: string;
        readonly recoveryAction: string;
        readonly path: string;
      }>(fixture, {
        mode: 'run_file_recovery',
        recoveryAction: 'redo',
        confirm: true,
        explicitUserRequest: 'Redo the last local file edit.',
      });
      expect(redo).toMatchObject({ status: 'applied', recoveryAction: 'redo', path: 'recoverable.txt' });
      expect(readFileSync(target, 'utf-8')).toBe('after content');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a read-only learning curator with ranked local review routes', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      (fixture.context.clients as Record<string, unknown>).agentKnowledgeApi = { memory: memoryRegistry };
      const memory = await memoryRegistry.add({
        cls: 'fact',
        summary: 'Use the private deployment checklist before release.',
        detail: 'Checklist is useful but still needs review.',
        tags: ['release'],
        review: { state: 'fresh', confidence: 42 },
        provenance: [{ kind: 'event', ref: 'test-learning-curator' }],
      });
      await memoryRegistry.add({
        cls: 'fact',
        summary: 'Use the private deployment checklist before release.',
        detail: 'Duplicate copy adds UX inventory and package verification context.',
        tags: ['release', 'ux-inventory'],
        review: { state: 'fresh', confidence: 84 },
        provenance: [{ kind: 'event', ref: 'test-learning-curator-duplicate' }],
      });
      const noteRegistry = AgentNoteRegistry.fromShellPaths(fixture.paths);
      const sourceNote = noteRegistry.create({
        title: 'Reviewed source note',
        body: 'Durable source note for later knowledge ingest.',
        sourceUrl: 'https://example.test/research',
        tags: ['research'],
        source: 'agent',
      });
      noteRegistry.markReviewed(sourceNote.id);
      const workflowNote = noteRegistry.create({
        title: 'Release checklist workflow',
        body: 'Repeat before release: check package verification, review UX inventory, and summarize residual risks.',
        tags: ['workflow', 'learned'],
        source: 'agent',
      });
      noteRegistry.markReviewed(workflowNote.id);
      const decisionNote = noteRegistry.create({
        title: 'Renderer decision memory',
        body: 'Decision: keep the existing renderer as the Agent UI foundation.',
        tags: ['decision', 'memory'],
        source: 'agent',
      });
      noteRegistry.markReviewed(decisionNote.id);
      const completedWork = fixture.context.workspace.workPlanStore!.addItem('Release readiness workflow', {
        status: 'done',
        owner: 'agent',
        source: 'test-learning-curator',
        notes: 'Repeat before release: run package verification, check UX inventory, and summarize residual risks.',
      });
      const completedDecision = fixture.context.workspace.workPlanStore!.addItem('Renderer decision capture', {
        status: 'done',
        owner: 'agent',
        source: 'test-learning-curator',
        notes: 'Decision: use the existing renderer for the autonomous Agent harness.',
      });
      const researchRunRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const researchRun = researchRunRegistry.create({
        title: 'Research report procedure',
        question: 'How should deep research reports stay sourced and reviewable?',
        goal: 'Define a reusable research report procedure.',
        plan: ['Review source credibility', 'Track citation coverage', 'Save report artifact'],
        provenance: 'test-learning-curator',
      });
      researchRunRegistry.start(researchRun.id, 'Started source review.');
      researchRunRegistry.checkpoint(researchRun.id, {
        phase: 'synthesizing',
        progress: 80,
        note: 'Procedure: check citation coverage before saving the report.',
        sourceIds: ['source-alpha'],
        nextSteps: ['Save report artifact'],
      });
      const completedResearch = researchRunRegistry.complete(researchRun.id, {
        note: 'Procedure: review source credibility, citation coverage, and report artifact before closing deep research.',
        reportArtifactId: 'artifact-research-1',
        sourceIds: ['source-alpha'],
      });
      const savedLearningSession = {
        name: 'session-release-review',
        title: 'Release review lesson session',
        model: 'gpt-4.1',
        provider: 'openai',
        timestamp: Date.now(),
        messageCount: 6,
        filePath: fixture.paths.resolveUserPath('sessions', 'session-release-review.json'),
      };
      (fixture.context.session as unknown as Record<string, unknown>).sessionManager = {
        list: () => [savedLearningSession],
        search: (query: string) => [savedLearningSession]
          .filter((session) => [session.name, session.title].join('\n').toLowerCase().includes(query.toLowerCase()))
          .map((session) => ({ session, matchCount: 1, snippets: ['Lesson: validate release evidence before closing.'] })),
        load: (name: string) => {
          if (name !== savedLearningSession.name) throw new Error(`Unknown session ${name}`);
          return {
            meta: { title: savedLearningSession.title },
            messages: [
              { role: 'user', content: 'Prepare the release review.' },
              { role: 'assistant', content: 'Lesson: when asked to prepare release review, run typecheck, package verification, UX inventory, and summarize residual risks.' },
            ],
          };
        },
      };
      const personaRegistry = AgentPersonaRegistry.fromShellPaths(fixture.paths);
      const persona = personaRegistry.create({
        name: 'Fresh operator persona',
        description: 'Fresh active behavior.',
        body: 'Prefer concise operational answers.',
        source: 'agent',
      });
      personaRegistry.setActive(persona.id);
      const reviewedPersona = personaRegistry.create({
        name: 'Reviewed release operator persona',
        description: 'Reviewed release behavior.',
        body: 'Keep release closeout concise and evidence-backed.',
        source: 'agent',
      });
      personaRegistry.markReviewed(reviewedPersona.id);
      personaRegistry.setActive(reviewedPersona.id);
      const skillRegistry = AgentSkillRegistry.fromShellPaths(fixture.paths);
      skillRegistry.create({
        name: 'Missing command skill',
        description: 'Needs an unavailable command before use.',
        procedure: 'Run the missing command and summarize results.',
        requirements: [{ kind: 'command', name: 'definitely-missing-goodvibes-agent-test-command' }],
        enabled: true,
        source: 'agent',
      });
      skillRegistry.create({
        name: 'Missing command skill!',
        description: 'Duplicate skill adds package verification and UX inventory notes.',
        procedure: 'Run package verification, check UX inventory, then summarize results.',
        triggers: ['release'],
        tags: ['release', 'verification'],
        source: 'agent',
      });

      const summary = await executeHarnessJson<{
        readonly learningCurator?: { readonly candidates: number; readonly needsReview: number; readonly needsSetup: number; readonly needsConsolidation: number; readonly lowConfidence: number; readonly proposedBehavior: number; readonly readOnly: boolean };
      }>(fixture, { mode: 'summary' });
      expect(summary.learningCurator?.candidates).toBeGreaterThan(3);
      expect(summary.learningCurator?.needsReview).toBeGreaterThan(0);
      expect(summary.learningCurator?.needsSetup).toBeGreaterThan(0);
      expect(summary.learningCurator?.needsConsolidation).toBeGreaterThan(0);
      expect(summary.learningCurator?.lowConfidence).toBeGreaterThan(0);
      expect(summary.learningCurator?.proposedBehavior).toBeGreaterThan(5);
      expect(summary.learningCurator?.readOnly).toBe(true);

      const curator = await executeHarnessJson<{
        readonly summary: { readonly candidates: number; readonly needsReview: number; readonly needsSetup: number; readonly needsConsolidation: number; readonly lowConfidence: number; readonly proposedBehavior: number; readonly readyToPromote: number };
        readonly consolidationBatch?: {
          readonly status: string;
          readonly candidates: number;
          readonly duplicateRecords: number;
          readonly domains: readonly { readonly domain: string; readonly candidates: number; readonly duplicateRecords: number }[];
          readonly routes: { readonly reviewQueue: string; readonly candidateDetail: string; readonly survivorRecord: string };
          readonly phases: readonly { readonly id: string; readonly route: string }[];
          readonly topCandidates: readonly {
            readonly candidateId: string;
            readonly survivorId: string;
            readonly duplicateIds?: readonly string[];
            readonly diffFields: readonly string[];
            readonly detailRoute: string;
            readonly applyRoute?: string;
            readonly mergeRoute?: string;
            readonly stalePhaseRoute?: string;
            readonly deletePhaseRoute?: string;
            readonly updateRoute?: string;
            readonly staleRoutes?: readonly string[];
            readonly deleteRoutes?: readonly string[];
            readonly rollbackRoutes?: readonly string[];
          }[];
          readonly policy: string;
        };
        readonly promptPlan: {
          readonly status: string;
          readonly promptActiveCount: number;
          readonly suppressedCount: number;
          readonly proposalCount: number;
          readonly consolidationCount: number;
          readonly promptActiveRecords: readonly { readonly id: string; readonly domain: string; readonly priority: number; readonly inspectRoute: string }[];
          readonly reviewFirst: readonly { readonly candidateId: string; readonly status: string; readonly scores: { readonly risk: number }; readonly reviewRoute?: string }[];
          readonly proposalQueue: readonly { readonly candidateId: string; readonly status: string; readonly createRoute?: string }[];
          readonly consolidationQueue: readonly { readonly candidateId: string; readonly status: string; readonly updateRoute?: string }[];
          readonly suppressed: { readonly needsReview: number; readonly needsSetup: number; readonly lowConfidence: number; readonly personalityIssues: number; readonly needsConsolidation: number };
          readonly orderingRules: readonly string[];
          readonly routes: { readonly memoryPosture: string; readonly curator: string; readonly candidate: string; readonly consolidation: string };
          readonly policy: string;
        };
        readonly candidates: readonly {
          readonly candidateId: string;
          readonly label: string;
          readonly domain: string;
          readonly status: string;
          readonly proposalTarget?: string;
          readonly proposalFields?: Record<string, string>;
          readonly priority: number;
          readonly scores: { readonly usefulness: number; readonly freshness: number; readonly sourceQuality: number; readonly risk: number };
          readonly inspectRoute: string;
          readonly reviewRoute?: string;
          readonly updateRoute?: string;
          readonly createRoute?: string;
          readonly cleanupRoutes?: readonly string[];
          readonly rollbackRoutes?: readonly string[];
          readonly consolidation?: {
            readonly survivorId: string;
            readonly duplicateIds: readonly string[];
            readonly diffs: readonly { readonly field: string; readonly survivor: string; readonly merged: string }[];
          };
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'learning_curator', includeParameters: true });
      expect(curator.summary.candidates).toBeGreaterThan(3);
      expect(curator.summary.readyToPromote).toBeGreaterThan(0);
      expect(curator.summary.proposedBehavior).toBeGreaterThan(5);
      expect(curator.summary.needsConsolidation).toBeGreaterThan(0);
      expect(curator.policy).toContain('duplicate consolidation');
      expect(curator.promptPlan.status).toBe('attention');
      expect(curator.promptPlan.promptActiveCount).toBeGreaterThan(0);
      expect(curator.promptPlan.suppressedCount).toBeGreaterThan(0);
      expect(curator.promptPlan.proposalCount).toBeGreaterThan(0);
      expect(curator.promptPlan.consolidationCount).toBeGreaterThan(0);
      expect(curator.promptPlan.promptActiveRecords.some((record) => record.domain === 'persona')).toBe(true);
      expect(curator.promptPlan.reviewFirst.some((candidate) => candidate.status === 'low-confidence' && candidate.scores.risk > 0)).toBe(true);
      expect(curator.promptPlan.proposalQueue.some((candidate) => candidate.candidateId.includes('note-proposal') && candidate.createRoute !== undefined)).toBe(true);
      expect(curator.promptPlan.consolidationQueue.some((candidate) => candidate.candidateId.includes('consolidation:skill'))).toBe(true);
      expect(curator.promptPlan.suppressed.lowConfidence).toBeGreaterThan(0);
      expect(curator.promptPlan.orderingRules.join('\n')).toContain('risk');
      expect(curator.promptPlan.routes.memoryPosture).toContain('memory action:"status"');
      expect(curator.promptPlan.routes.candidate).toContain('memory action:"candidate"');
      expect(curator.promptPlan.policy).toContain('read-only');
      expect(curator.consolidationBatch?.status).toBe('ready');
      expect(curator.consolidationBatch?.candidates).toBeGreaterThan(0);
      expect(curator.consolidationBatch?.duplicateRecords).toBeGreaterThan(0);
      expect(curator.consolidationBatch?.domains.some((domain) => domain.domain === 'skill')).toBe(true);
      expect(curator.consolidationBatch?.routes.reviewQueue).toContain('query:"consolidation"');
      expect(curator.consolidationBatch?.routes.candidateDetail).toContain('memory action:"candidate"');
      expect(curator.consolidationBatch?.phases.map((phase) => phase.id)).toEqual([
        'inspect',
        'merge-survivor',
        'stale-duplicates',
        'verify',
        'delete-after-approval',
      ]);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.candidateId.includes('consolidation:skill'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.updateRoute?.includes('action:"update"'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.applyRoute?.includes('agent_learning_consolidation'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.mergeRoute?.includes('mode=merge'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.stalePhaseRoute?.includes('mode=stale'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.deletePhaseRoute?.includes('mode=delete'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.staleRoutes?.join('\n').includes('action:"stale"'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.deleteRoutes?.join('\n').includes('confirm:true'))).toBe(true);
      expect(curator.consolidationBatch?.topCandidates.some((candidate) => candidate.rollbackRoutes?.join('\n').includes('rollback-learning-curator-consolidation'))).toBe(true);
      expect(curator.consolidationBatch?.policy).toContain('agent_learning_consolidation');
      expectRowsHaveCompactModelRoutes(curator.candidates);
      const memoryCandidate = curator.candidates.find((candidate) => candidate.candidateId === `memory:${memory.id}:low-confidence`);
      const personaCandidate = curator.candidates.find((candidate) => candidate.domain === 'persona' && candidate.status === 'needs-review');
      const setupCandidate = curator.candidates.find((candidate) => candidate.domain === 'skill' && candidate.status === 'needs-setup');
      const promoteCandidate = curator.candidates.find((candidate) => candidate.candidateId === `note-promote:${sourceNote.id}`);
      const proposalCandidate = curator.candidates.find((candidate) => candidate.candidateId === `note-proposal:routine:${workflowNote.id}`);
      const memoryNoteCandidate = curator.candidates.find((candidate) => candidate.candidateId === `note-proposal:memory:${decisionNote.id}`);
      const completedCandidate = curator.candidates.find((candidate) => candidate.candidateId === `work-plan-proposal:routine:${completedWork.id}`);
      const completedMemoryCandidate = curator.candidates.find((candidate) => candidate.candidateId === `work-plan-proposal:memory:${completedDecision.id}`);
      const researchCandidate = curator.candidates.find((candidate) => candidate.candidateId === `research-run-proposal:skill:${completedResearch.id}`);
      const sessionCandidate = curator.candidates.find((candidate) => candidate.candidateId === `session-proposal:skill:${savedLearningSession.name}`);
      const consolidationCandidate = curator.candidates.find((candidate) => candidate.status === 'needs-consolidation' && candidate.domain === 'skill');
      expect(memoryCandidate?.reviewRoute).toContain('agent_local_registry');
      expect(memoryCandidate?.scores.risk).toBeGreaterThan(0);
      expect(personaCandidate?.label).toContain('Fresh operator persona');
      expect(setupCandidate?.inspectRoute).toContain('domain:"skill"');
      expect(promoteCandidate?.createRoute).toContain('notes-to-knowledge');
      expect(proposalCandidate?.proposalTarget).toBe('routine');
      expect(proposalCandidate?.createRoute).toContain('notes-to-routine');
      expect(memoryNoteCandidate?.proposalTarget).toBe('memory');
      expect(memoryNoteCandidate?.createRoute).toContain('notes-to-memory');
      expect(completedCandidate?.domain).toBe('work_plan');
      expect(completedCandidate?.inspectRoute).toContain('agent_work_plan');
      expect(completedCandidate?.createRoute).toContain('learned-behavior');
      expect(completedCandidate?.proposalTarget).toBe('routine');
      expect(completedCandidate?.proposalFields?.target).toBe('routine');
      expect(completedCandidate?.proposalFields?.notes).toContain('Release readiness workflow');
      expect(completedMemoryCandidate?.proposalTarget).toBe('memory');
      expect(completedMemoryCandidate?.createRoute).toContain('memory-create');
      expect(completedMemoryCandidate?.proposalFields?.cls).toBe('decision');
      expect(completedMemoryCandidate?.proposalFields?.detail).toContain('existing renderer');
      expect(researchCandidate?.domain).toBe('research_run');
      expect(researchCandidate?.inspectRoute).toContain('mode:"research_run"');
      expect(researchCandidate?.createRoute).toContain('learned-behavior');
      expect(researchCandidate?.proposalTarget).toBe('skill');
      expect(researchCandidate?.proposalFields?.notes).toContain('artifact-research-1');
      expect(sessionCandidate?.domain).toBe('session');
      expect(sessionCandidate?.inspectRoute).toContain('sessions action:"get"');
      expect(sessionCandidate?.createRoute).toContain('learned-behavior');
      expect(sessionCandidate?.proposalTarget).toBe('skill');
      expect(sessionCandidate?.proposalFields?.notes).toContain('typecheck');
      expect(consolidationCandidate?.candidateId).toContain('consolidation:skill');
      expect(consolidationCandidate?.updateRoute).toContain('action:"update"');
      expect(consolidationCandidate?.cleanupRoutes?.join('\n')).toContain('action:"stale"');
      expect(consolidationCandidate?.rollbackRoutes?.join('\n')).toContain('action:"review"');
      expect(consolidationCandidate?.consolidation?.duplicateIds.length).toBeGreaterThan(0);
      expect(consolidationCandidate?.consolidation?.diffs.some((diff) => diff.field === 'description')).toBe(true);

      const candidate = await executeHarnessJson<{
        readonly candidateId: string;
        readonly routes?: { readonly inspect: string; readonly review: string | null };
      }>(fixture, { mode: 'learning_candidate', candidateId: `memory:${memory.id}:low-confidence` });
      expect(candidate.candidateId).toBe(`memory:${memory.id}:low-confidence`);
      expect(candidate.routes?.review).toContain('action:"review"');

      const consolidationDetail = await executeHarnessJson<{
        readonly candidateId: string;
        readonly status: string;
        readonly routes?: { readonly update: string | null; readonly stale: string | null; readonly delete: string | null; readonly apply?: string | null; readonly merge?: string | null; readonly stalePhase?: string | null; readonly deletePhase?: string | null };
        readonly cleanupRoutes?: readonly string[];
        readonly rollbackRoutes?: readonly string[];
      }>(fixture, { mode: 'learning_candidate', candidateId: consolidationCandidate?.candidateId });
      expect(consolidationDetail.status).toBe('needs-consolidation');
      expect(consolidationDetail.routes?.update).toContain('action:"update"');
      expect(consolidationDetail.routes?.apply).toContain('agent_learning_consolidation');
      expect(consolidationDetail.routes?.merge).toContain('mode=merge');
      expect(consolidationDetail.routes?.stalePhase).toContain('mode=stale');
      expect(consolidationDetail.routes?.deletePhase).toContain('mode=delete');
      expect(consolidationDetail.routes?.stale).toContain('action:"stale"');
      expect(consolidationDetail.routes?.delete).toContain('confirm:true');
      expect(consolidationDetail.cleanupRoutes?.join('\n')).toContain('Duplicate of');
      expect(consolidationDetail.rollbackRoutes?.join('\n')).toContain('rollback-learning-curator-consolidation');

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'memory-learning-curator' });
      expect(action.id).toBe('memory-learning-curator');
      expect(action.modelRoute).toBe('memory action:"curator"');

      const promptPlanAction = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'memory-prompt-plan' });
      expect(promptPlanAction.id).toBe('memory-prompt-plan');
      expect(promptPlanAction.modelRoute).toBe('memory action:"curator" includeParameters:true');

      const projectContextAction = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'context-project-files' });
      expect(projectContextAction.id).toBe('context-project-files');
      expect(projectContextAction.modelRoute).toBe('context action:"files"');

      const projectContextFileAction = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'context-project-file' });
      expect(projectContextFileAction.id).toBe('context-project-file');
      expect(projectContextFileAction.modelRoute).toBe('context action:"file"');
    } finally {
      fixture.cleanup();
    }
  });

  test('learning_auto_promote refuses to run without an explicit user request and confirm', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      (fixture.context.clients as Record<string, unknown>).agentKnowledgeApi = { memory: memoryRegistry };

      // No explicitUserRequest / confirm at all.
      const bare = await fixture.tool.execute({ mode: 'learning_auto_promote' });
      expect(bare.success).toBe(false);
      if (!bare.success) expect(bare.error).toContain('explicitUserRequest');

      // Explicit request but confirm not set.
      const unconfirmed = await fixture.tool.execute({
        mode: 'learning_auto_promote',
        explicitUserRequest: 'Promote the reviewed learnings.',
      });
      expect(unconfirmed.success).toBe(false);
      if (!unconfirmed.success) expect(unconfirmed.error).toContain('confirm:true');
    } finally {
      fixture.cleanup();
    }
  });

  test('learning_auto_promote promotes eligible candidates after confirmation', async () => {
    const fixture = makeFixture();
    try {
      // Wire up a real MemoryRegistry as the memoryApi (has .add())
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      (fixture.context.clients as Record<string, unknown>).agentKnowledgeApi = { memory: memoryRegistry };

      // Add a reviewed note with a session and a completed work-plan so the
      // learning curator produces skill proposal candidates for runSkillDraftProposer.
      const savedSession = {
        name: 'session-auto-promote-test',
        title: 'Auto-promote integration session',
        model: 'gpt-4.1',
        provider: 'openai',
        timestamp: Date.now(),
        messageCount: 4,
        filePath: fixture.paths.resolveUserPath('sessions', 'session-auto-promote-test.json'),
      };
      (fixture.context.session as unknown as Record<string, unknown>).sessionManager = {
        list: () => [savedSession],
        search: (query: string) => [savedSession]
          .filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
          .map((s) => ({ session: s, matchCount: 1, snippets: ['Lesson: run auto-promote pass after curator review.'] })),
        load: (name: string) => {
          if (name !== savedSession.name) throw new Error(`Unknown session ${name}`);
          return {
            meta: { title: savedSession.title },
            messages: [
              { role: 'user', content: 'Run auto-promote.' },
              { role: 'assistant', content: 'Lesson: invoke learning_auto_promote after curator review to promote skill drafts autonomously.' },
            ],
          };
        },
      };

      const result = await executeHarnessJson<{
        readonly eligible: number;
        readonly promoted: number;
        readonly skipped: number;
        readonly consolidated: number;
        readonly domains: Record<string, number>;
        readonly log: readonly string[];
        readonly message: string;
        readonly policy: string;
      }>(fixture, {
        mode: 'learning_auto_promote',
        confirm: true,
        explicitUserRequest: 'Promote the reviewed learnings from this session.',
      });

      // Shape assertions, the mode must always return these fields.
      expect(typeof result.eligible).toBe('number');
      expect(typeof result.promoted).toBe('number');
      expect(typeof result.skipped).toBe('number');
      expect(typeof result.consolidated).toBe('number');
      expect(Array.isArray(result.log)).toBe(true);
      expect(typeof result.message).toBe('string');
      expect(typeof result.policy).toBe('string');
      expect(result.policy).toContain('Secret scanning');
      // At minimum the skill-draft pass runs; promoted + skipped covers all eligible
      expect(result.promoted + result.skipped).toBeGreaterThanOrEqual(result.eligible);
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a read-only research source queue with report handoff routes', async () => {
    const fixture = makeFixture();
    try {
      const registry = AgentResearchSourceRegistry.fromShellPaths(fixture.paths);
      const candidate = registry.create({
        question: 'Which local model route should we try first?',
        title: 'Ollama setup docs',
        url: 'https://example.test/ollama?token=secret-token',
        publisher: 'Ollama',
        summary: 'Official setup docs for a simple local model route.',
        evidence: 'Setup flow is simple and local.',
        tags: ['local-models'],
        provenance: 'test-research-queue',
      });
      const reviewed = registry.review(candidate.id, {
        credibility: 'high',
        score: 91,
        note: 'Official source; useful for report citation.',
      });

      const summary = await executeHarnessJson<{
        readonly researchQueue?: { readonly sources: number; readonly reviewed: number; readonly readOnly: boolean };
      }>(fixture, { mode: 'summary' });
      expect(summary.researchQueue?.sources).toBe(1);
      expect(summary.researchQueue?.reviewed).toBe(1);
      expect(summary.researchQueue?.readOnly).toBe(true);

      const queue = await executeHarnessJson<{
        readonly summary: { readonly sources: number; readonly reviewed: number; readonly candidates: number };
        readonly bundle?: { readonly sources: number; readonly route: string; readonly reportRoute: string };
        readonly sources: readonly {
          readonly sourceId: string;
          readonly status: string;
          readonly credibility: string;
          readonly score: number;
          readonly modelRoute: string;
          readonly bundleRoute?: string;
          readonly reportRoute?: string;
          readonly ingestRoute?: string;
          readonly reportSourceLine: string;
          readonly url?: string;
        }[];
        readonly policy: string;
      }>(fixture, { mode: 'research_queue', includeParameters: true });
      expect(queue.summary.sources).toBe(1);
      expect(queue.summary.reviewed).toBe(1);
      expect(queue.summary.candidates).toBe(0);
      expect(queue.policy).toContain('Research queue is read-only');
      expect(queue.bundle?.sources).toBe(1);
      expect(queue.bundle?.route).toContain('research action:"bundle"');
      expect(queue.bundle?.reportRoute).toContain('requireCitationCoverage:true');
      expectRowsHaveCompactModelRoutes(queue.sources);
      expect(queue.sources[0]?.sourceId).toBe(reviewed.id);
      expect(queue.sources[0]?.status).toBe('reviewed');
      expect(queue.sources[0]?.credibility).toBe('high');
      expect(queue.sources[0]?.score).toBe(91);
      expect(queue.sources[0]?.bundleRoute).toContain('research action:"bundle"');
      expect(queue.sources[0]?.reportRoute).toContain('research action:"report"');
      expect(queue.sources[0]?.ingestRoute).toContain('agent_knowledge_ingest');
      expect(queue.sources[0]?.reportSourceLine).toContain('Ollama setup docs');
      expect(queue.sources[0]?.url).toContain('token=%3Credacted%3E');
      expect(queue.sources[0]?.url).not.toContain('secret-token');

      const source = await executeHarnessJson<{
        readonly sourceId: string;
        readonly bundleRoute?: string;
        readonly reportSourceLine: string;
        readonly policy?: string;
      }>(fixture, { mode: 'research_source', sourceId: reviewed.id });
      expect(source.sourceId).toBe(reviewed.id);
      expect(source.bundleRoute).toContain('research action:"bundle"');
      expect(source.reportSourceLine).toContain('high');
      expect(source.policy).toContain('Research queue rows are local project state only');

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'research-source-queue' });
      expect(action.id).toBe('research-source-queue');
      expect(action.modelRoute).toBe('research action:"sources"');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a read-only research run queue with checkpoint and cancel routes', async () => {
    const fixture = makeFixture();
    try {
      const registry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const run = registry.create({
        title: 'Competitor deep research',
        question: 'Which competitor features should GoodVibes Agent match?',
        goal: 'Produce a sourced parity and better-than-parity plan.',
        plan: ['Inventory competitors', 'Review GoodVibes capabilities'],
        nextSteps: ['Collect official sources'],
      });
      const started = registry.start(run.id, 'Starting source collection.');
      const checkpointed = registry.checkpoint(started.id, {
        phase: 'reading',
        progress: 40,
        note: 'Read official docs and captured source ids.',
        nextSteps: ['Draft findings'],
        sourceIds: ['official-docs'],
      });

      const summary = await executeHarnessJson<{
        readonly researchRuns?: { readonly runs: number; readonly running: number; readonly readOnly: boolean };
      }>(fixture, { mode: 'summary' });
      expect(summary.researchRuns?.runs).toBe(1);
      expect(summary.researchRuns?.running).toBe(1);
      expect(summary.researchRuns?.readOnly).toBe(true);

      const queue = await executeHarnessJson<{
        readonly summary: { readonly runs: number; readonly running: number; readonly cancellable: number };
        readonly runs: readonly {
          readonly runId: string;
          readonly status: string;
          readonly phase: string;
          readonly progress: number;
          readonly modelRoute: string;
          readonly checkpointRoute?: string;
          readonly cancelRoute?: string;
          readonly completeRoute?: string;
          readonly logTail: readonly string[];
          readonly runLine: string;
        }[];
        readonly runnerPosture: {
          readonly browserBackedResearch: {
            readonly status: string;
            readonly configured: boolean;
            readonly recommendedRoute: string;
            readonly fallbackRoutes: readonly string[];
            readonly workflows: readonly { readonly id: string; readonly status: string; readonly inspectRoute: string }[];
          };
          readonly sourceQueueRoute: string;
          readonly reportRoute: string;
          readonly policy: string;
        };
        readonly policy: string;
      }>(fixture, { mode: 'research_runs', includeParameters: true });
      expect(queue.summary.runs).toBe(1);
      expect(queue.summary.running).toBe(1);
      expect(queue.summary.cancellable).toBe(1);
      expect(queue.policy).toContain('Research runs are read-only');
      expectRowsHaveCompactModelRoutes(queue.runs);
      expect(queue.runs[0]?.runId).toBe(checkpointed.id);
      expect(queue.runs[0]?.status).toBe('running');
      expect(queue.runs[0]?.phase).toBe('reading');
      expect(queue.runs[0]?.progress).toBe(40);
      expect(queue.runs[0]?.checkpointRoute).toContain('research action:"checkpoint"');
      expect(queue.runs[0]?.cancelRoute).toContain('research action:"cancel"');
      expect(queue.runs[0]?.completeRoute).toContain('research action:"complete"');
      expect(queue.runs[0]?.logTail.join('\n')).toContain('Read official docs and captured source ids.');
      expect(queue.runs[0]?.runLine).toContain('Competitor deep research');
      expect(queue.runnerPosture.browserBackedResearch.status).toBe('setup-needed');
      expect(queue.runnerPosture.browserBackedResearch.configured).toBe(false);
      expect(queue.runnerPosture.browserBackedResearch.recommendedRoute).toContain('mcp_servers');
      expect(queue.runnerPosture.browserBackedResearch.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(queue.runnerPosture.browserBackedResearch.workflows[0]?.id).toBe('browser-navigation');
      expect(queue.runnerPosture.browserBackedResearch.workflows[0]?.inspectRoute).toContain('setup action:"item"');
      expect(queue.runnerPosture.sourceQueueRoute).toBe('research action:"sources"');
      expect(queue.runnerPosture.reportRoute).toContain('research action:"report"');
      expect(queue.runnerPosture.policy).toContain('browser-backed research');

      const detail = await executeHarnessJson<{
        readonly runId: string;
        readonly sourceIds: readonly string[];
        readonly checkpoints: readonly unknown[];
        readonly logTail: readonly string[];
        readonly policy?: string;
      }>(fixture, { mode: 'research_run', runId: checkpointed.id });
      expect(detail.runId).toBe(checkpointed.id);
      expect(detail.sourceIds).toEqual(['official-docs']);
      expect(detail.checkpoints).toHaveLength(1);
      expect(detail.logTail.join('\n')).toContain('Read official docs and captured source ids.');
      expect(detail.policy).toContain('Research run rows are local visible state only');

      const action = await executeHarnessJson<{
        readonly id: string;
        readonly modelRoute?: string;
      }>(fixture, { mode: 'workspace_action', actionId: 'research-run-queue' });
      expect(action.id).toBe('research-run-queue');
      expect(action.modelRoute).toBe('research action:"runs"');
    } finally {
      fixture.cleanup();
    }
  });

  test('plans a read-only deep research workflow across run, source, report, and Knowledge routes', async () => {
    const fixture = makeFixture();
    try {
      const runRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const sourceRegistry = AgentResearchSourceRegistry.fromShellPaths(fixture.paths);
      const run = runRegistry.create({
        title: 'Browser control research',
        question: 'How should GoodVibes Agent expose browser-backed research?',
        goal: 'Produce a sourced implementation plan.',
        plan: ['Collect current public sources', 'Review source credibility', 'Save a sourced report'],
        nextSteps: ['Find official browser-control docs'],
      });
      const started = runRegistry.start(run.id, 'Starting public source collection.');
      const candidate = sourceRegistry.create({
        question: started.question,
        title: 'Browser automation docs',
        url: 'https://example.test/browser-automation',
        publisher: 'Example Docs',
        summary: 'Browser automation setup and safety guidance.',
        tags: ['browser', 'research'],
        provenance: 'test-research-workflow',
      });
      const reviewed = sourceRegistry.review(candidate.id, {
        credibility: 'high',
        score: 88,
        note: 'Official-style source useful for report citation.',
      });

      const workflow = await executeHarnessJson<{
        readonly status: string;
        readonly question: string;
        readonly run?: { readonly runId: string; readonly checkpointRoute: string; readonly completeRoute: string };
        readonly sourcePosture: {
          readonly reviewed: number;
          readonly bundleRoute: string;
          readonly reportReadySources: readonly { readonly sourceId: string; readonly reportLine: string }[];
        };
        readonly browserBackedResearch: { readonly status: string; readonly fallbackRoutes: readonly string[] };
        readonly browserRunnerContract: {
          readonly status: string;
          readonly requiredContracts: readonly string[];
          readonly setupRoutes: readonly string[];
          readonly fallbackRoutes: readonly string[];
          readonly policy: string;
        };
        readonly visualReportContract: {
          readonly status: string;
          readonly currentRoute: string;
          readonly requiredSections: readonly string[];
          readonly acceptanceCriteria: readonly string[];
          readonly routes: { readonly saveVisualReport: string; readonly saveMarkdownReport: string; readonly archiveArtifacts: string };
          readonly policy: string;
        };
        readonly workflow: readonly { readonly id: string; readonly status: string; readonly route: string; readonly reportRoute?: string }[];
        readonly routes: { readonly saveReport: string; readonly completeRun?: string };
        readonly policy: string;
      }>(fixture, { mode: 'research_workflow', runId: started.id, includeParameters: true });
      expect(workflow.status).toBe('ready-to-report');
      expect(workflow.question).toContain('browser-backed research');
      expect(workflow.run?.runId).toBe(started.id);
      expect(workflow.run?.checkpointRoute).toContain('research action:"checkpoint"');
      expect(workflow.run?.completeRoute).toContain('research action:"complete"');
      expect(workflow.sourcePosture.reviewed).toBe(1);
      expect(workflow.sourcePosture.bundleRoute).toContain('research action:"bundle"');
      expect(workflow.sourcePosture.reportReadySources[0]?.sourceId).toBe(reviewed.id);
      expect(workflow.sourcePosture.reportReadySources[0]?.reportLine).toContain('Browser automation docs');
      expect(workflow.browserBackedResearch.status).toBe('setup-needed');
      expect(workflow.browserBackedResearch.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(workflow.browserRunnerContract.status).toBe('setup-contract-needed');
      expect(workflow.browserRunnerContract.requiredContracts.join('\n')).toContain('pause/resume/cancel controls');
      expect(workflow.browserRunnerContract.requiredContracts.join('\n')).toContain('Report draft/save handoff');
      expect(workflow.browserRunnerContract.setupRoutes.join('\n')).toContain('browser-desktop-control');
      expect(workflow.browserRunnerContract.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(workflow.browserRunnerContract.policy).toContain('not started by this workflow plan');
      expect(workflow.visualReportContract.status).toBe('visual-report-packet-ready');
      expect(workflow.visualReportContract.currentRoute).toContain('research action:"report"');
      expect(workflow.visualReportContract.requiredSections).toEqual(expect.arrayContaining(['evidence matrix', 'findings board', 'source map', 'handoff checklist']));
      expect(workflow.visualReportContract.acceptanceCriteria.join('\n')).toContain('citation');
      expect(workflow.visualReportContract.acceptanceCriteria.join('\n')).toContain('visualReport:true');
      expect(workflow.visualReportContract.routes.saveVisualReport).toContain('visualReport:true');
      expect(workflow.visualReportContract.routes.saveMarkdownReport).toContain('research action:"report"');
      expect(workflow.visualReportContract.routes.archiveArtifacts).toContain('agent_artifacts mode:"archive"');
      expect(workflow.visualReportContract.policy).toContain('read-only planning');
      expect(workflow.workflow.map((step) => step.id)).toEqual(['visible-run', 'collect-sources', 'review-sources', 'save-report', 'promote-knowledge']);
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.status).toBe('ready');
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.reportRoute).toContain('visualReport:true');
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.reportRoute).toContain('research action:"report"');
      expect(workflow.routes.saveReport).toContain('visualReport:true');
      expect(workflow.routes.saveReport).toContain('requireCitationCoverage:true');
      expect(workflow.routes.completeRun).toContain(started.id);
      expect(workflow.policy).toContain('read-only workflow plan');

      const briefing = await executeHarnessJson<{
        readonly status: string;
        readonly summary: {
          readonly activeRuns: number;
          readonly reviewedSources: number;
          readonly candidateSources: number;
          readonly browserReady: boolean;
        };
        readonly queue: readonly {
          readonly id: string;
          readonly kind: string;
          readonly status: string;
          readonly routes: Record<string, string>;
          readonly confirmationBoundary: string;
        }[];
        readonly routes: { readonly search: string; readonly saveReport: string };
        readonly policy: string;
      }>(fixture, { mode: 'research_briefing', target: started.id, includeParameters: true });
      expect(briefing.status).toBe('ready-to-report');
      expect(briefing.summary.activeRuns).toBe(1);
      expect(briefing.summary.reviewedSources).toBe(1);
      expect(briefing.summary.candidateSources).toBe(0);
      expect(briefing.summary.browserReady).toBe(false);
      const runItem = briefing.queue.find((item) => item.id === `run:${started.id}`);
      expect(runItem?.kind).toBe('run');
      expect(runItem?.routes.search).toContain(`runId:"${started.id}"`);
      expect(runItem?.routes.checkpoint).toContain('research action:"checkpoint"');
      expect(runItem?.confirmationBoundary).toContain('read-only');
      const sourceItem = briefing.queue.find((item) => item.id === `source:${reviewed.id}`);
      expect(sourceItem?.kind).toBe('source');
      expect(sourceItem?.routes.report).toContain('visualReport:true');
      expect(sourceItem?.routes.bundle).toContain('research action:"bundle"');
      const browserItem = briefing.queue.find((item) => item.id === 'browser:research-runner');
      expect(browserItem?.routes.runner).toBe('research action:"runner"');
      expect(briefing.routes.search).toContain('research action:"search"');
      expect(briefing.routes.saveReport).toContain('requireCitationCoverage:true');
      expect(briefing.policy).toContain('Research briefing is read-only');

      const fresh = await executeHarnessJson<{
        readonly status: string;
        readonly browserRunnerContract: { readonly status: string; readonly fallbackRoutes: readonly string[] };
        readonly visualReportContract: {
          readonly status: string;
          readonly currentRoute: string;
          readonly routes: { readonly reviewedSourceBundle: string };
        };
        readonly workflow: readonly { readonly id: string; readonly status: string; readonly route: string }[];
        readonly routes: { readonly createRun: string };
      }>(fixture, { mode: 'research_workflow', query: 'new competitor research request' });
      expect(fresh.status).toBe('needs-visible-run');
      expect(fresh.browserRunnerContract.status).toBe('setup-contract-needed');
      expect(fresh.browserRunnerContract.fallbackRoutes.join('\n')).toContain('web-fetch-research');
      expect(fresh.visualReportContract.status).toBe('waiting-for-reviewed-sources');
      expect(fresh.visualReportContract.currentRoute).toContain('research action:"bundle"');
      expect(fresh.visualReportContract.routes.reviewedSourceBundle).toContain('new competitor research request');
      expect(fresh.workflow.find((step) => step.id === 'visible-run')?.status).toBe('needed');
      expect(fresh.workflow.find((step) => step.id === 'visible-run')?.route).toContain('research action:"create_run"');
      expect(fresh.routes.createRun).toContain('new competitor research request');
    } finally {
      fixture.cleanup();
    }
  });

  test('consumes certified live research runner and visual report read models', async () => {
    const fixture = makeFixture();
    try {
      const runRegistry = AgentResearchRunRegistry.fromShellPaths(fixture.paths);
      const sourceRegistry = AgentResearchSourceRegistry.fromShellPaths(fixture.paths);
      const run = runRegistry.create({
        title: 'Live browser research',
        question: 'Which browser-backed research evidence should count for release?',
        goal: 'Verify live runner and visual report read models.',
        plan: ['Collect source receipts', 'Review citations', 'Inspect rendered report'],
        nextSteps: ['Inspect certified runner record'],
      });
      const started = runRegistry.start(run.id, 'Waiting for daemon browser runner evidence.');
      const candidate = sourceRegistry.create({
        question: started.question,
        title: 'Live research source',
        url: 'https://example.test/live-research',
        publisher: 'Example Research',
        summary: 'Live browser-backed research receipt evidence.',
        tags: ['research', 'browser'],
        provenance: 'test-live-research-runner',
      });
      sourceRegistry.review(candidate.id, {
        credibility: 'high',
        score: 91,
        note: 'Useful certified source receipt.',
      });

      const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
      platform.readModels.research = {
        browserRuns: {
          getSnapshot: () => ({
            records: [{
              id: 'live-runner-1',
              runId: started.id,
              status: 'running',
              phase: 'reading',
              progress: 67,
              question: started.question,
              currentUrl: 'https://research.example.test/page?token=runner-url-secret',
              sourceReceiptIds: ['source-receipt-1'],
              reportDraftId: 'draft-report-1',
              logTail: ['Captured page token=runner-log-secret', 'Saved one source receipt.'],
              routes: {
                inspect: `research action:"runner" runId:"${started.id}" includeParameters:true`,
                checkpoint: `research action:"checkpoint" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
                pause: `research action:"pause" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
                resume: `research action:"resume" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
                cancel: `research action:"cancel" id:"${started.id}" confirm:true explicitUserRequest:"..."`,
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.research.browser-run.v1',
              publicationGuarantee: 'daemon publishes browser research source receipts token=runner-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method research.browserRuns.list', 'sourceTool browser-runner'],
              cursor: 'research-runner-cursor-1',
              receiptId: 'research-runner-receipt-1',
              redaction: 'bounded-page-summary-only',
            }],
          }),
        },
        visualReports: {
          getSnapshot: () => ({
            records: [{
              id: 'visual-report-render-1',
              reportArtifactId: 'artifact-report-1',
              status: 'rendered',
              modelRoute: 'research action:"report_artifact" artifactId:"artifact-report-1"',
              renderRoute: 'computer action:"open_browser" surfaceId:"research-report-artifact-report-1" confirm:true explicitUserRequest:"..."',
              renderUrl: 'https://research.example.test/reports/artifact-report-1?secret=render-url-secret',
              sections: ['at-a-glance summary', 'evidence matrix', 'findings board', 'source map', 'handoff checklist'],
              sourceMapCount: 1,
              citationCoverage: '1/1 material claims covered token=render-coverage-secret',
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.research.visual-report.v1',
              publicationGuarantee: 'daemon publishes visual report render receipts secret=render-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method research.visualReports.list', 'sourceTool report-renderer'],
              cursor: 'visual-report-cursor-1',
              receiptId: 'visual-report-receipt-1',
            }],
          }),
        },
      };

      const workflow = await executeHarnessJson<{
        readonly browserBackedResearch: {
          readonly status: string;
          readonly configured: boolean;
          readonly liveRunnerRecords: readonly {
            readonly currentUrl: string;
            readonly logTail: readonly string[];
            readonly certification: { readonly missingSignals: readonly string[]; readonly publicationGuarantee?: string };
          }[];
        };
        readonly browserRunnerContract: {
          readonly status: string;
          readonly certifiedLiveRecords: readonly {
            readonly sourceReceiptIds: readonly string[];
            readonly certification: { readonly missingSignals: readonly string[]; readonly receiptId?: string };
          }[];
        };
        readonly visualReportContract: {
          readonly status: string;
          readonly currentRoute: string;
          readonly routes: { readonly openRenderedReport?: string };
          readonly certifiedRendererRecords: readonly {
            readonly sections: readonly string[];
            readonly renderUrl: string;
            readonly certification: { readonly missingSignals: readonly string[]; readonly publicationGuarantee?: string };
          }[];
        };
        readonly workflow: readonly { readonly id: string; readonly status: string; readonly route: string }[];
        readonly routes: { readonly liveRunner?: string; readonly liveVisualReport?: string };
      }>(fixture, { mode: 'research_workflow', runId: started.id, includeParameters: true });

      expect(workflow.browserBackedResearch.status).toBe('certified-live-runner');
      expect(workflow.browserBackedResearch.configured).toBe(true);
      expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.currentUrl).toContain('token=%3Credacted%3E');
      expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.logTail.join('\n')).toContain('token=<redacted>');
      expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
      expect(workflow.browserBackedResearch.liveRunnerRecords[0]?.certification.missingSignals).toEqual([]);
      expect(workflow.browserRunnerContract.status).toBe('certified-live-runner');
      expect(workflow.browserRunnerContract.certifiedLiveRecords[0]?.sourceReceiptIds).toContain('source-receipt-1');
      expect(workflow.browserRunnerContract.certifiedLiveRecords[0]?.certification.receiptId).toBe('research-runner-receipt-1');
      expect(workflow.browserRunnerContract.certifiedLiveRecords[0]?.certification.missingSignals).toEqual([]);
      expect(workflow.visualReportContract.status).toBe('certified-live-renderer');
      expect(workflow.visualReportContract.currentRoute).toContain('report_artifact');
      expect(workflow.visualReportContract.routes.openRenderedReport).toContain('computer action:"open_browser"');
      expect(workflow.visualReportContract.certifiedRendererRecords[0]?.sections).toEqual(expect.arrayContaining(['evidence matrix', 'source map']));
      expect(workflow.visualReportContract.certifiedRendererRecords[0]?.renderUrl).toContain('secret=%3Credacted%3E');
      expect(workflow.visualReportContract.certifiedRendererRecords[0]?.certification.publicationGuarantee).toContain('secret=<redacted>');
      expect(workflow.visualReportContract.certifiedRendererRecords[0]?.certification.missingSignals).toEqual([]);
      expect(workflow.workflow.find((step) => step.id === 'collect-sources')?.status).toBe('ready');
      expect(workflow.workflow.find((step) => step.id === 'collect-sources')?.route).toContain('research action:"runner"');
      expect(workflow.workflow.find((step) => step.id === 'save-report')?.route).toContain('report_artifact');
      expect(workflow.routes.liveRunner).toContain('research action:"runner"');
      expect(workflow.routes.liveVisualReport).toContain('report_artifact');

      const briefing = await executeHarnessJson<{
        readonly summary: { readonly browserReady: boolean; readonly liveBrowserRuns: number; readonly liveVisualReports: number };
        readonly queue: readonly { readonly id: string; readonly status: string; readonly routes: Record<string, string>; readonly detail?: Record<string, unknown> }[];
      }>(fixture, { mode: 'research_briefing', target: started.id, includeParameters: true });
      expect(briefing.summary.browserReady).toBe(true);
      expect(briefing.summary.liveBrowserRuns).toBe(1);
      expect(briefing.summary.liveVisualReports).toBe(1);
      const browserItem = briefing.queue.find((item) => item.id === 'browser:research-runner');
      expect(browserItem?.status).toBe('certified-live-runner');
      expect(browserItem?.routes.visualReport).toContain('report_artifact');

      const runs = await executeHarnessJson<{
        readonly runnerPosture: {
          readonly browserBackedResearch: { readonly status: string; readonly certifiedLiveRecords: readonly unknown[] };
          readonly visualReportRendering: { readonly status: string; readonly certifiedLiveRecords: readonly unknown[] };
        };
      }>(fixture, { mode: 'research_runs', includeParameters: true });
      expect(runs.runnerPosture.browserBackedResearch.status).toBe('certified-live-runner');
      expect(runs.runnerPosture.browserBackedResearch.certifiedLiveRecords).toHaveLength(1);
      expect(runs.runnerPosture.visualReportRendering.status).toBe('certified-live-renderer');
      expect(runs.runnerPosture.visualReportRendering.certifiedLiveRecords).toHaveLength(1);
      expect(JSON.stringify({ workflow, briefing, runs })).not.toContain('runner-url-secret');
      expect(JSON.stringify({ workflow, briefing, runs })).not.toContain('runner-log-secret');
      expect(JSON.stringify({ workflow, briefing, runs })).not.toContain('runner-publication-secret');
      expect(JSON.stringify({ workflow, briefing, runs })).not.toContain('render-url-secret');
      expect(JSON.stringify({ workflow, briefing, runs })).not.toContain('render-coverage-secret');
      expect(JSON.stringify({ workflow, briefing, runs })).not.toContain('render-publication-secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes Document Ops readiness with an honest blind comparison runner', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      registerStubTool(fixture.toolRegistry, 'agent_documents');
      fixture.toolRegistry.register(createAgentArtifactsTool(artifacts.store));
      registerStubTool(fixture.toolRegistry, 'agent_knowledge_ingest');
      registerStubTool(fixture.toolRegistry, 'agent_model_compare');
      const documentRegistry = AgentDocumentRegistry.fromShellPaths(fixture.paths);
      const draft = documentRegistry.create({
        title: 'Reviewer packet',
        body: 'Draft reviewer packet body.',
        tags: ['review'],
      });
      documentRegistry.addComment(draft.id, { body: 'Clarify the release evidence section.' });
      documentRegistry.suggestUpdate(draft.id, {
        body: 'Draft reviewer packet body with clearer evidence.',
        summary: 'Clarify evidence section.',
        rationale: 'Reviewer asked for more explicit evidence.',
      });
      const savedComparison = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-cmp_hidden.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare',
          comparisonId: 'cmp_hidden',
          candidateCount: 2,
          completedCandidates: 2,
          revealIncludedInTranscript: false,
        },
      });
      await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-judgment-hidden.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare-judgment',
          judgmentId: 'judgment-hidden',
          comparisonId: 'cmp_hidden',
          sourceArtifactId: savedComparison.id,
          winnerBlindId: 'A',
          revealIncludedInJudgment: false,
        },
      });
      const revealedJudgment = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-judgment-revealed.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare-judgment',
          judgmentId: 'judgment-revealed',
          comparisonId: 'cmp_revealed',
          winnerBlindId: 'B',
          winnerModel: 'openai:gpt-4.1',
          revealIncludedInJudgment: true,
        },
      });
      await artifacts.store.create({
        kind: 'data',
        mimeType: 'text/markdown',
        filename: 'blind-model-comparison-handoff-missing.md',
        text: '# Handoff',
        metadata: {
          purpose: 'agent-model-compare-handoff',
          handoffId: 'handoff-missing',
          comparisonId: 'cmp_revealed',
          sourceArtifactId: revealedJudgment.id,
          sourceKind: 'judgment',
          relatedArtifactIds: [],
          revealIncludedInHandoff: true,
        },
      });
      const summary = await executeHarnessJson<{
        readonly documentOps?: { readonly lanes: number; readonly ready: number; readonly attention: number; readonly partial: number; readonly gap: number };
      }>(fixture, { mode: 'summary' });
      expect(summary.documentOps?.lanes).toBe(10);
      expect(summary.documentOps?.ready).toBeGreaterThanOrEqual(2);
      expect(summary.documentOps?.attention).toBeGreaterThanOrEqual(1);
      expect(summary.documentOps?.partial).toBeGreaterThanOrEqual(1);
      expect(summary.documentOps?.gap).toBe(0);

      const ops = await executeHarnessJson<{
        readonly reviewerReadiness?: {
          readonly status: string;
          readonly summary: {
            readonly openComments: number;
            readonly proposedSuggestions: number;
            readonly documentsMissingSourceArtifacts: number;
            readonly unrevealedComparisons: number;
            readonly hiddenJudgments: number;
            readonly revealedJudgments: number;
            readonly handoffsMissingRelatedArtifacts: number;
          };
          readonly checks: readonly {
            readonly id: string;
            readonly status: string;
            readonly count: number;
            readonly inspectRoute: string;
            readonly repairRoute?: string;
          }[];
        };
        readonly lanes: readonly {
          readonly id: string;
          readonly status: string;
          readonly current: string;
          readonly reviewPacketWizard?: {
            readonly status: string;
            readonly currentStepLabel?: string | null;
            readonly steps: readonly {
              readonly id: string;
              readonly status: string;
              readonly modelRoute: string;
              readonly backtrackRoute?: string;
            }[];
          };
          readonly reviewerReadiness?: {
            readonly status: string;
            readonly checks: readonly {
              readonly id: string;
              readonly status: string;
              readonly count: number;
              readonly repairRoute?: string;
            }[];
          };
          readonly actionIds?: readonly string[];
        }[];
        readonly policy: string;
        readonly nextActions: readonly string[];
      }>(fixture, { mode: 'document_ops', includeParameters: true });
      expect(ops.policy).toContain('model comparison');
      expect(ops.policy).toContain('AI suggestion review');
      expect(ops.policy).toContain('chronological review packet timelines');
      expect(ops.nextActions.join('\n')).not.toContain('AI suggestion review');

      const documents = ops.lanes.find((lane) => lane.id === 'documents');
      const uploads = ops.lanes.find((lane) => lane.id === 'uploads');
      const exports = ops.lanes.find((lane) => lane.id === 'exports');
      const reviewerReadiness = ops.lanes.find((lane) => lane.id === 'reviewer_readiness');
      const reviewPacketTimeline = ops.lanes.find((lane) => lane.id === 'review_packet_timeline');
      const reviewPacketWizard = ops.lanes.find((lane) => lane.id === 'review_packet_wizard');
      const sourceLibrary = ops.lanes.find((lane) => lane.id === 'source_library');
      const artifactBrowser = ops.lanes.find((lane) => lane.id === 'artifact_browser');
      const modelCompare = ops.lanes.find((lane) => lane.id === 'model_compare');
      expect(documents?.status).toBe('ready');
      expect(documents?.current).toContain('version history');
      expect(documents?.actionIds).toContain('document-create-draft');
      expect(documents?.actionIds).toContain('document-revise-draft');
      expect(documents?.actionIds).toContain('document-comment-draft');
      expect(documents?.actionIds).toContain('document-resolve-comment');
      expect(documents?.actionIds).toContain('document-suggest-draft');
      expect(documents?.actionIds).toContain('document-accept-suggestion');
      expect(documents?.actionIds).toContain('document-reject-suggestion');
      expect(documents?.actionIds).toContain('document-insert-artifact');
      expect(documents?.actionIds).toContain('document-attach-artifact');
      expect(documents?.actionIds).toContain('document-export-draft');
      expect(exports?.actionIds).toContain('document-export-artifact-file');
      expect(exports?.actionIds).toContain('document-export-artifact-package');
      expect(exports?.actionIds).toContain('document-export-artifact-file');
      expect(exports?.actionIds).toContain('document-export-artifact-package');
      expect(uploads?.status).toBe('ready');
      expect(uploads?.actionIds).toContain('document-ingest-file');
      expect(exports?.status).toBe('ready');
      expect(exports?.actionIds).toContain('document-export-conversation');
      expect(reviewerReadiness?.status).toBe('attention');
      expect(reviewerReadiness?.current).toContain('1 open comment');
      expect(reviewerReadiness?.actionIds).toContain('document-reviewer-readiness');
      expect(reviewerReadiness?.actionIds).toContain('document-resolve-comment');
      expect(reviewerReadiness?.actionIds).toContain('document-accept-suggestion');
      expect(reviewerReadiness?.actionIds).toContain('document-apply-compare');
      expect(reviewPacketTimeline?.status).toBe('attention');
      expect(reviewPacketTimeline?.current).toContain('packet event');
      expect(reviewPacketTimeline?.actionIds).toContain('document-review-packet-timeline');
      expect(reviewPacketTimeline?.actionIds).toContain('document-review-compare');
      expect(reviewPacketWizard?.status).toBe('attention');
      expect(reviewPacketWizard?.current).toContain('Draft review');
      expect(reviewPacketWizard?.actionIds).toContain('document-review-packet-wizard');
      expect(reviewPacketWizard?.actionIds).toContain('document-share-review-packet');
      expect(reviewPacketWizard?.actionIds).toContain('document-export-draft');
      expect(reviewPacketWizard?.reviewPacketWizard?.currentStepLabel).toBe('Draft review');
      expect(reviewPacketWizard?.reviewPacketWizard?.steps.map((step) => step.id)).toContain('route-decision');
      expect(ops.reviewerReadiness?.status).toBe('attention');
      expect(ops.reviewerReadiness?.summary.openComments).toBe(1);
      expect(ops.reviewerReadiness?.summary.proposedSuggestions).toBe(1);
      expect(ops.reviewerReadiness?.summary.documentsMissingSourceArtifacts).toBe(1);
      expect(ops.reviewerReadiness?.summary.unrevealedComparisons).toBe(1);
      expect(ops.reviewerReadiness?.summary.hiddenJudgments).toBe(1);
      expect(ops.reviewerReadiness?.summary.revealedJudgments).toBe(1);
      expect(ops.reviewerReadiness?.summary.handoffsMissingRelatedArtifacts).toBe(1);
      const reviewCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'document-review-state');
      const revealCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'comparison-reveal');
      const routeDecisionCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'route-change-decision');
      const handoffCheck = ops.reviewerReadiness?.checks.find((check) => check.id === 'handoff-archive-evidence');
      expect(reviewCheck?.status).toBe('attention');
      expect(reviewCheck?.repairRoute).toContain('resolveComment');
      expect(revealCheck?.repairRoute).toContain('agent_model_compare reveal');
      expect(routeDecisionCheck?.repairRoute).toContain(`artifactId:"${revealedJudgment.id}"`);
      expect(handoffCheck?.repairRoute).toContain('relatedArtifactIds');
      expect(sourceLibrary?.status).toBe('ready');
      expect(artifactBrowser?.status).toBe('ready');
      expect(artifactBrowser?.current).toContain('unified artifact browser');
      expect(artifactBrowser?.current).toContain('artifact export-to-file');
      expect(artifactBrowser?.current).toContain('multi-artifact package export');
      expect(artifactBrowser?.current).toContain('artifact-to-Knowledge promotion');
      expect(artifactBrowser?.actionIds).toContain('document-browse-artifacts');
      expect(artifactBrowser?.actionIds).toContain('document-show-artifact');
      expect(artifactBrowser?.actionIds).toContain('document-export-artifact-file');
      expect(artifactBrowser?.actionIds).toContain('document-export-artifact-package');
      expect(artifactBrowser?.actionIds).toContain('document-promote-artifact');
      expect(artifactBrowser?.actionIds).toContain('document-insert-artifact');
      expect(artifactBrowser?.actionIds).toContain('document-attach-artifact');
      expect(artifactBrowser?.actionIds).toContain('document-promote-artifact');
      expect(modelCompare?.status).toBe('partial');
      expect(modelCompare?.current).toContain('confirmed blind comparison runner');
      expect(modelCompare?.actionIds).toContain('document-run-compare');
      expect(modelCompare?.actionIds).toContain('document-review-compare');
      expect(modelCompare?.actionIds).toContain('document-diff-handoffs');
      expect(modelCompare?.actionIds).toContain('document-judge-compare');
      expect(modelCompare?.actionIds).toContain('document-compare-analytics');
      expect(modelCompare?.actionIds).toContain('document-apply-compare');
      expect(modelCompare?.actionIds).toContain('document-export-compare');

      const artifactLane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly routes?: { readonly model: string };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'artifact_browser' });
      expect(artifactLane.id).toBe('artifact_browser');
      expect(artifactLane.status).toBe('ready');
      expect(artifactLane.routes?.model).toBe('agent_artifacts + agent_knowledge_ingest');

      const lane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly routes?: { readonly model: string };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'model_compare' });
      expect(lane.id).toBe('model_compare');
      expect(lane.status).toBe('partial');
      expect(lane.routes?.model).toBe('agent_model_compare');

      const reviewerLane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly reviewerReadiness?: {
          readonly checks: readonly { readonly id: string; readonly repairRoute?: string }[];
        };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'reviewer_readiness' });
      expect(reviewerLane.id).toBe('reviewer_readiness');
      expect(reviewerLane.status).toBe('attention');
      expect(reviewerLane.reviewerReadiness?.checks.find((check) => check.id === 'source-artifacts')?.repairRoute).toContain('attachArtifact');

      const timelineLane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly current: string;
        readonly next: string;
        readonly signals: readonly string[];
        readonly routes?: { readonly model: string };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'review_packet_timeline' });
      expect(timelineLane.id).toBe('review_packet_timeline');
      expect(timelineLane.status).toBe('attention');
      expect(timelineLane.current).toContain('packet event');
      expect(timelineLane.signals.join('\n')).toContain('handoff');
      expect(timelineLane.signals.join('\n')).toContain('agent_model_compare');
      expect(timelineLane.routes?.model).toBe('agent_harness mode:"document_ops_lane" laneId:"review_packet_timeline"');

      const wizardLane = await executeHarnessJson<{
        readonly id: string;
        readonly status: string;
        readonly current: string;
        readonly next: string;
        readonly reviewPacketWizard?: {
          readonly progress: string;
          readonly currentStepLabel?: string | null;
          readonly steps: readonly { readonly id: string; readonly modelRoute: string; readonly backtrackRoute?: string }[];
        };
        readonly routes?: { readonly model: string };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'review_packet_wizard' });
      expect(wizardLane.id).toBe('review_packet_wizard');
      expect(wizardLane.status).toBe('attention');
      expect(wizardLane.current).toContain('Draft review');
      expect(wizardLane.reviewPacketWizard?.progress).toBe('1/6');
      expect(wizardLane.reviewPacketWizard?.currentStepLabel).toBe('Draft review');
      expect(wizardLane.reviewPacketWizard?.steps.find((step) => step.id === 'route-decision')?.modelRoute).toContain('agent_model_compare apply');
      expect(wizardLane.routes?.model).toBe('agent_harness mode:"document_ops_lane" laneId:"review_packet_wizard"');

      const readinessAction = await executeHarnessJson<{
        readonly status: string;
        readonly action: string;
        readonly tool: string;
        readonly output?: { readonly id?: string; readonly reviewerReadiness?: { readonly status?: string } };
      }>(fixture, {
        mode: 'run_workspace_action',
        actionId: 'document-reviewer-readiness',
        fields: { includeRoutes: 'yes' },
      });
      expect(readinessAction.status).toBe('executed_harness_lane');
      expect(readinessAction.action).toBe('document-reviewer-readiness');
      expect(readinessAction.tool).toBe('agent_harness');
      expect(readinessAction.output?.id).toBe('reviewer_readiness');
      expect(readinessAction.output?.reviewerReadiness?.status).toBe('attention');

      const wizardAction = await executeHarnessJson<{
        readonly status: string;
        readonly action: string;
        readonly tool: string;
        readonly output?: { readonly id?: string; readonly reviewPacketWizard?: { readonly currentStepLabel?: string | null } };
      }>(fixture, {
        mode: 'run_workspace_action',
        actionId: 'document-review-packet-wizard',
        fields: { includeRoutes: 'yes' },
      });
      expect(wizardAction.status).toBe('executed_harness_lane');
      expect(wizardAction.action).toBe('document-review-packet-wizard');
      expect(wizardAction.tool).toBe('agent_harness');
      expect(wizardAction.output?.id).toBe('review_packet_wizard');
      expect(wizardAction.output?.reviewPacketWizard?.currentStepLabel).toBe('Draft review');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes compact model routes across product posture catalogs', async () => {
    const fixture = makeFixture();
    try {
      fixture.configManager.setDynamic('notifications.webhookUrls' as unknown as Parameters<typeof fixture.configManager.setDynamic>[0], ['https://example.test/hooks/alpha?token=secret']);

      const channels = await executeHarnessJson<{
        readonly channels: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'channels', limit: 3 });
      expectRowsHaveCompactModelRoutes(channels.channels);

      fixture.configManager.setDynamic('surfaces.telegram.enabled', true);
      fixture.configManager.setDynamic('surfaces.telegram.botToken', 'telegram-secret-token');
      const channelGuide = await executeHarnessJson<{
        readonly guide: {
          readonly currentChannelId: string | null;
          readonly currentStepId: string | null;
          readonly steps: readonly { readonly id: string; readonly status: string; readonly userRoute: string }[];
          readonly policy: string;
        };
      }>(fixture, { mode: 'channel_setup_guide', channelId: 'telegram' });
      expect(channelGuide.guide.currentChannelId).toBe('telegram');
      expect(channelGuide.guide.currentStepId).toBe('choose-delivery-target');
      expect(channelGuide.guide.steps.find((step) => step.id === 'review-policy')?.userRoute).toBe('/channels policies');
      expect(channelGuide.guide.steps.find((step) => step.id === 'send-explicit-test')?.status).toBe('pending');
      expect(channelGuide.guide.policy).toContain('Read-only channel setup guide');
      expect(JSON.stringify(channelGuide)).not.toContain('telegram-secret-token');

      recordAgentChannelDeliveryReceipt(fixture.paths, {
        source: 'model-tool',
        deliveryInput: {
          message: 'Confirm api_key=super-secret-value',
          webhook: 'https://hooks.example.test/services/T000/B000/secret-token',
        },
        result: {
          message: 'Confirm api_key=super-secret-value',
          title: 'Delivery Check',
          target: { kind: 'webhook', address: 'https://hooks.example.test/services/T000/B000/secret-token' },
          strategyCount: 1,
          responseId: 'response-1',
        },
      });
      const deliveries = await executeHarnessJson<{
        readonly mode: string;
        readonly total: number;
        readonly receipts: readonly {
          readonly receiptId: string;
          readonly target: { readonly display: string; readonly addressDigest?: string };
          readonly messagePreview: string;
          readonly responseId: string | null;
        }[];
      }>(fixture, { mode: 'channel_deliveries' });
      expect(deliveries.mode).toBe('channel_deliveries');
      expect(deliveries.total).toBe(1);
      expect(deliveries.receipts[0]?.target.display).toBe('webhook https://hooks.example.test/...');
      expect(deliveries.receipts[0]?.target.addressDigest).toBeTruthy();
      expect(deliveries.receipts[0]?.messagePreview).toContain('api_key=[redacted]');
      expect(deliveries.receipts[0]?.responseId).toBe('response-1');
      expect(JSON.stringify(deliveries)).not.toContain('secret-token');
      expect(JSON.stringify(deliveries)).not.toContain('super-secret-value');

      const originalFetch = globalThis.fetch;
      const channelTriageToken = 'channel-triage-token';
      try {
        writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: channelTriageToken }));
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          expect(readAuthorizationHeader(init?.headers)).toBe(`Bearer ${channelTriageToken}`);
          const path = new URL(String(input)).pathname;
          if (path === '/api/deliveries') {
            return new Response(JSON.stringify({
              totals: { queued: 1, started: 2, succeeded: 1, failed: 1, deadLettered: 0 },
              attempts: [{
                id: 'delivery-triage-1',
                runId: 'run-triage-1',
                jobId: 'job-triage-1',
                status: 'failed',
                target: { kind: 'webhook', address: 'https://hooks.example.test/services/T000/B000/harness-secret-token' },
                error: 'HTTP 500 api_key=harness-secret-value',
              }],
            }));
          }
          if (path === '/api/control-plane/messages') {
            return new Response(JSON.stringify({
              messages: [{
                id: 'surface-message-1',
                surface: 'slack',
                createdAt: 1,
                title: 'Route token=surface-secret-value',
                body: 'Body with https://hooks.example.test/services/T000/B000/surface-secret-token',
                level: 'warn',
                routeId: 'route-1',
              }],
            }));
          }
          if (path === '/api/routes/bindings') {
            return new Response(JSON.stringify({
              bindings: [{
                id: 'binding-triage-1',
                kind: 'channel',
                surfaceKind: 'slack',
                surfaceId: 'slack',
                externalId: 'C-harness-secret-channel',
                title: 'Ops',
                lastSeenAt: 1,
              }],
            }));
          }
          return new Response('not found', { status: 404 });
        }) as typeof globalThis.fetch;

        const triage = await executeHarnessJson<{
          readonly mode: string;
          readonly status: string;
          readonly deliveries: {
            readonly retryCandidateCount: number;
            readonly retryCandidates: readonly { readonly target: { readonly address?: string; readonly addressDigest?: string }; readonly error?: string }[];
          };
          readonly surfaceMessages: { readonly totalMessages: number; readonly messages: readonly { readonly title: string; readonly bodyPreview: string }[] };
          readonly routeBindings: { readonly totalBindings: number; readonly bindings: readonly { readonly externalIdDigest: string | null }[] };
          readonly inboundFeed: { readonly providerInboxFeed: string };
        }>(fixture, { mode: 'channel_triage', limit: 3 });
        expect(triage.mode).toBe('channel_triage');
        expect(triage.status).toBe('attention');
        expect(triage.deliveries.retryCandidateCount).toBe(1);
        expect(triage.deliveries.retryCandidates[0]?.target.address).toBe('https://hooks.example.test/...');
        expect(triage.deliveries.retryCandidates[0]?.target.addressDigest).toBeTruthy();
        expect(triage.deliveries.retryCandidates[0]?.error).toBe('HTTP 500 api_key=[redacted]');
        expect(triage.surfaceMessages.totalMessages).toBe(1);
        expect(triage.surfaceMessages.messages[0]?.title).toBe('Route token=[redacted]');
        expect(triage.surfaceMessages.messages[0]?.bodyPreview).toContain('[redacted-url]');
        expect(triage.routeBindings.totalBindings).toBe(1);
        expect(triage.routeBindings.bindings[0]?.externalIdDigest).toContain('sha256:');
        expect(triage.inboundFeed.providerInboxFeed).toBe('not_published_by_current_channel_contract');
        expect(JSON.stringify(triage)).not.toContain(channelTriageToken);
        expect(JSON.stringify(triage)).not.toContain('harness-secret-token');
        expect(JSON.stringify(triage)).not.toContain('harness-secret-value');
        expect(JSON.stringify(triage)).not.toContain('surface-secret-token');
        expect(JSON.stringify(triage)).not.toContain('surface-secret-value');
        expect(JSON.stringify(triage)).not.toContain('C-harness-secret-channel');
      } finally {
        globalThis.fetch = originalFetch;
      }

      const notifications = await executeHarnessJson<{
        readonly targets: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'notifications' });
      expectRowsHaveCompactModelRoutes(notifications.targets);
      expect(notifications.targets[0]?.value).toBe('<redacted>');

      const providerAccounts = await executeHarnessJson<{
        readonly providers: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'provider_accounts', query: 'openai', limit: 5 });
      expectRowsHaveCompactModelRoutes(providerAccounts.providers);

      const mcpServers = await executeHarnessJson<{
        readonly servers: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'mcp_servers' });
      expectRowsHaveCompactModelRoutes(mcpServers.servers);

      const modelRouting = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'model_routing', limit: 5 });
      expectRowsHaveCompactModelRoutes(modelRouting.routes);
      expect(modelRouting.routes.filter((route) => route.commands !== undefined || route.uiSurfaces !== undefined)).toEqual([]);

      const execution = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'execution_posture' });
      expectRowsHaveCompactModelRoutes(execution.routes);

      const fileRecovery = await executeHarnessJson<{
        readonly actions: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'file_recovery' });
      expectRowsHaveCompactModelRoutes(fileRecovery.actions);

      const pairing = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'pairing_posture' });
      expectRowsHaveCompactModelRoutes(pairing.routes);
      expect(pairing.routes.filter((route) => route.harnessRoute !== undefined)).toEqual([]);

      const delegation = await executeHarnessJson<{
        readonly routes: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'delegation_posture' });
      expectRowsHaveCompactModelRoutes(delegation.routes);
      expect(delegation.routes.filter((route) => route.commandTemplate !== undefined)).toEqual([]);

      const expandedDelegation = await executeHarnessJson<{
        readonly summary: {
          readonly decisionCards: number;
          readonly operatorClientAttached: boolean;
        };
        readonly decisionCards: readonly {
          readonly id: string;
          readonly lane: string;
          readonly status: string;
          readonly supervision: readonly string[];
        }[];
        readonly routes: readonly {
          readonly delegationRouteId: string;
          readonly effect: string;
          readonly lane: string;
          readonly requiredFields: readonly string[];
          readonly statusRoutes: readonly string[];
          readonly recoveryRoutes: readonly string[];
        }[];
      }>(fixture, { mode: 'delegation_posture', includeParameters: true });
      expect(expandedDelegation.summary.decisionCards).toBeGreaterThanOrEqual(5);
      expect(expandedDelegation.summary.operatorClientAttached).toBe(false);
      expect(expandedDelegation.decisionCards.find((card) => card.lane === 'tui-shared-session')?.status).toBe('operator-needed');
      expect(expandedDelegation.decisionCards.find((card) => card.lane === 'remote-runner')?.supervision.join('\n')).toContain('/health remote');
      expect(expandedDelegation.routes.find((route) => route.delegationRouteId === 'delegate-build-task')?.requiredFields.join('\n')).toContain('success criteria');
      expect(expandedDelegation.routes.find((route) => route.delegationRouteId === 'remote-runner-inspection')?.statusRoutes.join('\n')).toContain('/health remote');
      expect(expandedDelegation.routes.find((route) => route.delegationRouteId === 'hidden-local-fanout-blocked')?.effect).toBe('blocked');

      const expandedDelegationRoute = await executeHarnessJson<{
        readonly delegationRouteId: string;
        readonly lane: string;
        readonly requiredFields: readonly string[];
        readonly successEvidence: readonly string[];
        readonly recoveryRoutes: readonly string[];
        readonly modelAccess: { readonly runWorkspaceAction?: string };
      }>(fixture, { mode: 'delegation_route', delegationRouteId: 'delegate-build-task' });
      expect(expandedDelegationRoute.lane).toBe('tui-shared-session');
      expect(expandedDelegationRoute.requiredFields.join('\n')).toContain('delegation reason');
      expect(expandedDelegationRoute.successEvidence.join('\n')).toContain('verification result');
      expect(expandedDelegationRoute.recoveryRoutes.join('\n')).toContain('GoodVibes TUI');
      expect(expandedDelegationRoute.modelAccess.runWorkspaceAction).toContain('delegate-task');

      const security = await executeHarnessJson<{
        readonly findings: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'security_posture' });
      expectRowsHaveCompactModelRoutes(security.findings);

      const bundles = await executeHarnessJson<{
        readonly bundles: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'support_bundles' });
      expectRowsHaveCompactModelRoutes(bundles.bundles);
      expect(bundles.bundles.filter((bundle) => bundle.exportCommand !== undefined || bundle.workspaceActionIds !== undefined)).toEqual([]);

      const media = await executeHarnessJson<{
        readonly providers: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'media_posture' });
      expectRowsHaveCompactModelRoutes(media.providers);

      const sessions = await executeHarnessJson<{
        readonly sessions: readonly Record<string, unknown>[];
        readonly bookmarks: Record<string, unknown>;
      }>(fixture, { mode: 'sessions' });
      expectRowsHaveCompactModelRoutes(sessions.sessions);
      expectCompactModelRoute(sessions.bookmarks.modelRoute);
      expect(sessions.bookmarks.modelRoutes).toBeUndefined();

      const operatorMethods = await executeHarnessJson<{
        readonly methods: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'operator_methods', query: 'automation.schedules.create' });
      expectRowsHaveCompactModelRoutes(operatorMethods.methods);
      expect(operatorMethods.methods[0]?.preferredModelTool).toBeUndefined();

      const service = await executeHarnessJson<{
        readonly modelRoute?: string;
        readonly endpoints: readonly Record<string, unknown>[];
      }>(fixture, { mode: 'service_posture' });
      expectCompactModelRoute(service.modelRoute);
      expectRowsHaveCompactModelRoutes(service.endpoints);

      const expandedMcp = await executeHarnessJson<{
        readonly servers: readonly { readonly modelAccess?: Record<string, unknown> }[];
      }>(fixture, { mode: 'mcp_servers', includeParameters: true });
      expect(expandedMcp.servers[0]?.modelAccess).toMatchObject({
        reviewCommand: '/mcp review',
        serversCommand: '/mcp servers',
        configCommand: '/mcp config',
      });

      const expandedOperatorMethod = await executeHarnessJson<{
        readonly modelRoute?: string;
        readonly preferredModelTool?: string;
      }>(fixture, { mode: 'operator_method', methodId: 'automation.schedules.create' });
      expectCompactModelRoute(expandedOperatorMethod.modelRoute);
      expect(expandedOperatorMethod.preferredModelTool).toContain('agent_operator_method');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a companion device capability map with honest unpublished sensor posture', async () => {
    const fixture = makeFixture();
    try {
      writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({
        token: 'device-map-secret-token',
      }));
      fixture.configManager.setDynamic('controlPlane.enabled', true);
      fixture.configManager.setDynamic('web.enabled', true);
      fixture.configManager.setDynamic('ui.voiceEnabled', true);
      fixture.configManager.setDynamic('tts.provider', 'stream-voice');
      fixture.configManager.setDynamic('tts.voice', '');
      fixture.configManager.setDynamic('notifications.webhookUrls' as unknown as Parameters<typeof fixture.configManager.setDynamic>[0], ['https://hooks.example.test/device-map/secret-token']);
      fixture.configManager.setDynamic('surfaces.telegram.enabled', true);
      fixture.configManager.setDynamic('surfaces.telegram.botToken', 'telegram-secret-token');

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly deviceCapabilities: {
            readonly total: number;
            readonly ready: number;
            readonly attention: number;
            readonly setupNeeded: number;
            readonly notPublished: number;
            readonly primaryNextStep: string;
          };
        };
        readonly pairing: {
          readonly endpoint: { readonly enabled: boolean };
          readonly token: { readonly present: boolean; readonly rawValueReturned: boolean };
        };
        readonly deviceCapabilities: readonly {
          readonly id: string;
          readonly status: string;
          readonly summary: string;
          readonly evidence?: Record<string, unknown>;
          readonly setupRoutes?: readonly string[];
          readonly policy?: string;
        }[];
      }>(fixture, { mode: 'pairing_posture', query: 'device', includeParameters: true });

      expect(posture.summary.deviceCapabilities.total).toBeGreaterThanOrEqual(8);
      expect(posture.summary.deviceCapabilities.ready).toBeGreaterThanOrEqual(3);
      expect(posture.summary.deviceCapabilities.attention).toBeGreaterThanOrEqual(1);
      expect(posture.summary.deviceCapabilities.notPublished).toBe(1);
      expect(posture.pairing.endpoint.enabled).toBe(true);
      expect(posture.pairing.token).toMatchObject({ present: true, rawValueReturned: false });
      expect(posture.deviceCapabilities.find((capability) => capability.id === 'browser-cockpit-pwa')?.status).toBe('ready');
      expect(posture.deviceCapabilities.find((capability) => capability.id === 'voice-controls')?.status).toBe('attention');
      expect(posture.deviceCapabilities.find((capability) => capability.id === 'browser-desktop-control')?.status).toBe('setup-needed');
      const sensors = posture.deviceCapabilities.find((capability) => capability.id === 'camera-location-sensors');
      expect(sensors?.status).toBe('not-published');
      expect(sensors?.summary).toContain('not published');
      expect(sensors?.setupRoutes?.join('\n')).toContain('host action:"methods"');
      expect(JSON.stringify(posture)).not.toContain('device-map-secret-token');
      expect(JSON.stringify(posture)).not.toContain('telegram-secret-token');
      expect(JSON.stringify(posture)).not.toContain('secret-token');

      const route = await executeHarnessJson<{
        readonly pairingRouteId: string;
        readonly deviceCapabilityMap: {
          readonly capabilities: readonly { readonly id: string; readonly status: string }[];
          readonly policy: string;
        };
      }>(fixture, { mode: 'pairing_route', query: 'camera location' });
      expect(route.pairingRouteId).toBe('device-capability-map');
      expect(route.deviceCapabilityMap.capabilities.find((capability) => capability.id === 'camera-location-sensors')?.status).toBe('not-published');
      expect(route.deviceCapabilityMap.policy).toContain('does not pair devices');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes voice interaction workflow posture, with the wake row reporting what this surface actually does', async () => {
    const fixture = makeFixture();
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = 'voice-workflow-secret-key';
      fixture.configManager.setDynamic('ui.voiceEnabled', true);
      fixture.configManager.setDynamic('tts.provider', 'openai');
      fixture.configManager.setDynamic('tts.voice', 'alloy');
      (fixture.context as { submitSpokenInput?: (text: string) => void }).submitSpokenInput = () => {};
      (fixture.context as { stopSpokenOutput?: () => void }).stopSpokenOutput = () => {};
      const voiceRegistry = fixture.context.platform.voiceProviderRegistry as {
        list: () => readonly { readonly id: string; readonly label: string; readonly capabilities: readonly string[] }[];
        status?: () => Promise<readonly { readonly id: string; readonly state: string; readonly configured: boolean; readonly detail?: string }[]>;
      };
      voiceRegistry.list = () => [{ id: 'openai', label: 'OpenAI Voice', capabilities: ['tts', 'stt', 'realtime', 'voice-list'] }];
      voiceRegistry.status = async () => [{ id: 'openai', state: 'ready', configured: true, detail: 'OpenAI voice ready.' }];
      (fixture.context.platform as {
        voiceService?: {
          listVoices?: (providerId?: string) => Promise<readonly { readonly id: string; readonly label: string }[]>;
          transcribe?: () => Promise<{ readonly text: string }>;
        };
      }).voiceService = {
        listVoices: async (providerId?: string) => [{ id: `${providerId ?? 'default'}-voice-a`, label: 'Voice A' }],
        transcribe: async () => ({ text: 'transcribed text' }),
      };

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly voiceWorkflows: {
            readonly ready: number;
            readonly notPublished: number;
          };
        };
        readonly voiceWorkflows: readonly {
          readonly id: string;
          readonly status: string;
          readonly summary: string;
          readonly nextStep: string;
          readonly setupRoutes: readonly string[];
          readonly evidence: Record<string, unknown>;
          readonly policy: string;
        }[];
      }>(fixture, { mode: 'media_posture', query: 'voice', includeParameters: true });

      expect(posture.summary.voiceWorkflows.ready).toBeGreaterThanOrEqual(3);
      expect(posture.voiceWorkflows.find((workflow) => workflow.id === 'push-to-talk')?.status).toBe('ready');
      expect(posture.voiceWorkflows.find((workflow) => workflow.id === 'voice-memo-transcription')?.status).toBe('ready');
      expect(posture.voiceWorkflows.find((workflow) => workflow.id === 'spoken-responses')?.status).toBe('ready');
      // Wake capture IS shipped on this surface, and its delivery row ships off, so
      // the honest posture at defaults is setup-needed with the exact rows to flip,
      // not the "not-published" it read while nothing captured audio anywhere. The
      // phone half is still unpublished and says so in its own evidence field.
      const wake = posture.voiceWorkflows.find((workflow) => workflow.id === 'wake-and-speak');
      expect(wake?.status).toBe('setup-needed');
      expect(wake?.summary).toContain('voice.wake.surfaces.agent is off');
      // The next step describes what YOU do for the user, not a command to hand
      // over: setting the row also moves the surface row and fetches the models.
      expect(wake?.nextStep).toContain('Set voice.wake.enabled');
      expect(wake?.nextStep).not.toContain('/voice');
      expect(wake?.evidence.localCaptureHost).toBe(true);
      expect(wake?.evidence.listening).toBe(false);
      expect(wake?.evidence.companionWakePublishedByCurrentAgentContract).toBe(false);
      expect(wake?.policy).toContain('does not claim always-listening');

      // Both rows on and nothing refusing: the same posture reads ready.
      fixture.configManager.setDynamic('voice.wake.enabled', true);
      fixture.configManager.setDynamic('voice.wake.surfaces.agent', true);
      const listening = await executeHarnessJson<{
        readonly voiceWorkflows: readonly { readonly id: string; readonly status: string; readonly evidence: Record<string, unknown> }[];
      }>(fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
      expect(listening.voiceWorkflows[0]?.status).toBe('ready');
      expect(listening.voiceWorkflows[0]?.evidence.listening).toBe(true);

      // A row that refuses to start the detector is an attention state, named.
      fixture.configManager.setDynamic('voice.wake.vadThreshold', 0.5);
      const blocked = await executeHarnessJson<{
        readonly voiceWorkflows: readonly { readonly id: string; readonly status: string; readonly evidence: Record<string, unknown> }[];
      }>(fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
      expect(blocked.voiceWorkflows[0]?.status).toBe('attention');
      expect(blocked.voiceWorkflows[0]?.evidence.blockedRows).toEqual(['voice.wake.vadThreshold']);
      fixture.configManager.setDynamic('voice.wake.vadThreshold', 0);
      fixture.configManager.setDynamic('voice.wake.enabled', false);
      fixture.configManager.setDynamic('voice.wake.surfaces.agent', false);
      expect(JSON.stringify(posture)).not.toContain('voice-workflow-secret-key');

      const pushToTalk = await executeHarnessJson<{
        readonly voiceWorkflows: readonly { readonly id: string; readonly status: string }[];
      }>(fixture, { mode: 'media_posture', query: 'push to talk', includeParameters: true });
      expect(pushToTalk.voiceWorkflows.map((workflow) => workflow.id)).toEqual(['push-to-talk']);
      expect(pushToTalk.voiceWorkflows[0]?.status).toBe('ready');
    } finally {
      if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previousOpenAiKey;
      fixture.cleanup();
    }
  });

  test('consumes certified companion device capability records for sensors and wake word', async () => {
    const fixture = makeFixture();
    try {
      const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
      platform.readModels.device = {
        capabilities: {
          getSnapshot: () => ({
            records: [
              {
                id: 'device-sensors-live-1',
                capabilityId: 'camera-location-sensors',
                label: 'Phone camera screen and location',
                domain: 'device',
                status: 'ready',
                summary: 'Foreground camera, screen, location, and device commands are available token=sensor-summary-secret',
                capabilities: ['camera', 'screen capture', 'location', 'local device command'],
                permissionScope: 'foreground-camera-location-screen',
                routes: {
                  inspect: 'device action:"capability" capabilityId:"camera-location-sensors" includeParameters:true',
                  capture: 'device action:"capability" capabilityId:"camera-location-sensors" confirm:true explicitUserRequest:"..."',
                  repairPermission: 'device action:"capability" capabilityId:"camera-location-sensors" repairPermission:true confirm:true explicitUserRequest:"..."',
                },
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.device.capability.v1',
                publicationGuarantee: 'daemon publishes permission-scoped sensor receipts secret=sensor-publication-secret',
                publisher: 'goodvibes-daemon',
                provenance: ['method device.capabilities.list', 'sourceTool companion-daemon'],
                cursor: 'device-sensor-cursor-1',
                receiptId: 'device-sensor-receipt-1',
              },
              {
                id: 'wake-word-live-1',
                capabilityId: 'wake-and-speak',
                label: 'Wake word route',
                domain: 'voice',
                status: 'ready',
                summary: 'Foreground wake-word route with visible microphone controls token=wake-summary-secret',
                capabilities: ['wake word', 'always listening', 'microphone permission repair'],
                permissionScope: 'foreground-microphone-wake-word',
                routes: {
                  inspect: 'device action:"voice" query:"wake word" includeParameters:true',
                  open: 'device action:"voice" query:"wake word" confirm:true explicitUserRequest:"..."',
                  repairPermission: 'device action:"voice" query:"wake word permission" confirm:true explicitUserRequest:"..."',
                },
                schemaStatus: 'certified',
                schemaVersion: 'goodvibes.device.voice-workflow.v1',
                publicationGuarantee: 'daemon publishes wake-word permission receipts token=wake-publication-secret',
                publisher: 'goodvibes-daemon',
                provenance: ['method voice.workflows.list', 'sourceTool companion-daemon'],
                cursor: 'wake-word-cursor-1',
                receiptId: 'wake-word-receipt-1',
              },
            ],
          }),
        },
      };

      const posture = await executeHarnessJson<{
        readonly summary: {
          readonly deviceCapabilities: {
            readonly ready: number;
            readonly notPublished: number;
          };
        };
        readonly deviceCapabilities: readonly {
          readonly id: string;
          readonly status: string;
          readonly summary: string;
          readonly modelRoute: string;
          readonly evidence?: {
            readonly certifiedLiveRecords?: readonly {
              readonly summary?: string;
              readonly certification: { readonly missingSignals: readonly string[]; readonly publicationGuarantee?: string; readonly receiptId?: string };
            }[];
          };
        }[];
      }>(fixture, { mode: 'pairing_posture', query: 'device', includeParameters: true });

      expect(posture.summary.deviceCapabilities.notPublished).toBe(0);
      const sensors = posture.deviceCapabilities.find((capability) => capability.id === 'camera-location-sensors');
      expect(sensors?.status).toBe('ready');
      expect(sensors?.summary).toContain('certified');
      expect(sensors?.modelRoute).toContain('camera-location-sensors');
      expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.summary).toContain('token=<redacted>');
      expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.certification.publicationGuarantee).toContain('secret=<redacted>');
      expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.certification.receiptId).toBe('device-sensor-receipt-1');
      expect(sensors?.evidence?.certifiedLiveRecords?.[0]?.certification.missingSignals).toEqual([]);

      const route = await executeHarnessJson<{
        readonly deviceCapabilityMap: {
          readonly capabilities: readonly {
            readonly id: string;
            readonly status: string;
            readonly evidence?: { readonly certifiedLiveRecords?: readonly unknown[] };
          }[];
        };
      }>(fixture, { mode: 'pairing_route', query: 'camera location' });
      expect(route.deviceCapabilityMap.capabilities.find((capability) => capability.id === 'camera-location-sensors')?.status).toBe('ready');
      expect(route.deviceCapabilityMap.capabilities.find((capability) => capability.id === 'camera-location-sensors')?.evidence?.certifiedLiveRecords).toHaveLength(1);

      const wake = await executeHarnessJson<{
        readonly summary: { readonly voiceWorkflows: { readonly ready: number; readonly notPublished: number } };
        readonly voiceWorkflows: readonly {
          readonly id: string;
          readonly status: string;
          readonly modelRoute: string;
          readonly evidence: { readonly certifiedLiveRecords?: readonly { readonly summary?: string; readonly certification: { readonly publicationGuarantee?: string; readonly missingSignals: readonly string[] } }[] };
        }[];
      }>(fixture, { mode: 'media_posture', query: 'wake word', includeParameters: true });
      expect(wake.voiceWorkflows.map((workflow) => workflow.id)).toEqual(['wake-and-speak']);
      expect(wake.voiceWorkflows[0]?.status).toBe('ready');
      expect(wake.voiceWorkflows[0]?.modelRoute).toContain('wake word');
      expect(wake.voiceWorkflows[0]?.evidence.certifiedLiveRecords?.[0]?.summary).toContain('token=<redacted>');
      expect(wake.voiceWorkflows[0]?.evidence.certifiedLiveRecords?.[0]?.certification.publicationGuarantee).toContain('token=<redacted>');
      expect(wake.voiceWorkflows[0]?.evidence.certifiedLiveRecords?.[0]?.certification.missingSignals).toEqual([]);
      expect(JSON.stringify({ posture, route, wake })).not.toContain('sensor-summary-secret');
      expect(JSON.stringify({ posture, route, wake })).not.toContain('sensor-publication-secret');
      expect(JSON.stringify({ posture, route, wake })).not.toContain('wake-summary-secret');
      expect(JSON.stringify({ posture, route, wake })).not.toContain('wake-publication-secret');
    } finally {
      fixture.cleanup();
    }
  });

  // DELETED: 'exposes a local model cookbook through model routing and workspace actions'
  // account-local-model-cookbook, account-route-readiness, account-local-benchmark-evidence removed.
  // DELETED: 'exposes a local model cookbook through model routing and workspace actions'
  // account-local-model-cookbook, account-route-readiness, account-local-benchmark-evidence removed.;

  test('maps discovered local provider endpoints into smoke-testable server health', async () => {
    const previousEndpointEnv = clearEnvForTest(LOCAL_MODEL_ENDPOINT_ENV_KEYS);
    const fixture = makeFixture();
    try {
      const registry = fixture.context.provider.providerRegistry as unknown as {
        listModels: () => readonly unknown[];
        listProviders?: () => readonly unknown[];
      };
      registry.listModels = () => [{
        provider: 'ollama-local',
        modelId: 'qwen2.5-coder:7b',
        registryKey: 'ollama-local:qwen2.5-coder:7b',
        displayName: 'qwen2.5-coder:7b',
        description: 'Discovered local model on http://127.0.0.1:11434/v1',
        baseURL: 'http://127.0.0.1:11434/v1',
        serverType: 'ollama',
        contextWindow: 8192,
        capabilities: { toolCalling: true, multimodal: false },
      }];
      registry.listProviders = () => [{
        name: 'ollama-local',
        baseURL: 'http://127.0.0.1:11434/v1',
        models: ['qwen2.5-coder:7b'],
      }];
      (fixture.context.platform as unknown as { readModels: Record<string, unknown> }).readModels = {
        ...((fixture.context.platform as unknown as { readModels?: Record<string, unknown> }).readModels ?? {}),
        models: {
          servingDiagnostics: {
            getSnapshot: () => ({
              servers: {
                ollama: {
                  providerId: 'ollama-local',
                  baseUrl: 'http://127.0.0.1:11434/v1',
                  stack: 'ollama',
                  status: 'ready',
                  schemaStatus: 'certified',
                  schemaVersion: 'goodvibes.local-serving.v1',
                  sourceTool: 'models.local.servingDiagnostics',
                  provenance: ['daemon:local-serving', 'method:models.local.servingDiagnostics'],
                  publicationGuarantee: 'daemon publishes local serving diagnostics after start/repair receipts token=serving-secret',
                  publisher: 'goodvibes-daemon',
                  serverVersion: 'ollama 0.3.2',
                  loadedModels: ['qwen2.5-coder:7b'],
                  contextWindowTokens: 8192,
                  toolSupport: true,
                  resourcePressure: 'low',
                  memoryUsagePercent: 42,
                  startReceiptId: 'ollama-start-receipt',
                  repairReceiptId: 'ollama-repair-receipt',
                  receiptStatus: 'ready',
                  startRoute: 'agent_operator_method methodId:"models.local.start" confirm:true explicitUserRequest:"Start the published Ollama server."',
                  repairRoute: 'agent_operator_method methodId:"models.local.repair" confirm:true explicitUserRequest:"Repair the published Ollama server."',
                  lastCheckedAt: '2026-06-07T10:00:00.000Z',
                  summary: 'Ollama token=raw-secret is ready with one loaded model.',
                },
              },
            }),
          },
        },
      };

      const cookbook = await executeHarnessJson<{
        readonly localCookbook: {
          readonly status: string;
          readonly detected: {
            readonly providerIds: readonly string[];
            readonly modelRoutes: readonly string[];
            readonly stacks: readonly string[];
          };
          readonly localServerHealth: {
            readonly status: string;
            readonly liveProbe: string;
            readonly endpointCount: number;
            readonly endpoints: readonly {
              readonly kind: string;
              readonly id: string;
              readonly providerId: string | null;
              readonly stack: string | null;
              readonly baseUrl: string;
              readonly modelsUrl: string;
              readonly diagnosticStatus: string;
              readonly inspectRoute: string;
              readonly sources: readonly string[];
              readonly sourceDetails: readonly string[];
              readonly modelRoutes: readonly string[];
              readonly smokeCommand: string;
              readonly smokeRoute: string;
              readonly refreshRoute: string;
              readonly addProviderRoute: string | null;
              readonly notes: readonly string[];
              readonly servingDiagnostics?: {
                readonly status: string;
                readonly source: string;
                readonly summary: string;
                readonly schemaStatus?: string;
                readonly schemaVersion?: string;
                readonly provenance?: readonly string[];
                readonly publicationGuarantee?: string;
                readonly publisher?: string;
                readonly serverVersion?: string;
                readonly loadedModelCount?: number;
                readonly loadedModels: readonly string[];
                readonly contextWindowTokens?: number;
                readonly toolSupport?: boolean;
                readonly resourcePressure: string;
                readonly resourceSummary?: string;
                readonly lastCheckedAt?: string | null;
                readonly startReceiptId?: string;
                readonly repairReceiptId?: string;
                readonly receiptStatus?: string;
                readonly startRoute?: string;
                readonly repairRoute?: string;
                readonly inspectRoute: string;
                readonly missingSignals: readonly string[];
                readonly policy: string;
              };
              readonly diagnostics?: {
                readonly successCriteria: readonly string[];
                readonly failureTriage: readonly string[];
                readonly afterSmoke: readonly string[];
                readonly policy: string;
              };
            }[];
            readonly daemonDiagnostics: {
              readonly status: string;
              readonly sourcePaths: readonly string[];
              readonly recordCount: number;
              readonly matchedEndpointCount: number;
              readonly missingSignals: readonly string[];
              readonly policy: string;
            };
            readonly nextActions: readonly string[];
            readonly policy: string;
          };
        };
      }>(fixture, { mode: 'model_routing', query: 'local', includeParameters: true });

      expect(cookbook.localCookbook.status).toBe('detected-local-route');
      expect(cookbook.localCookbook.detected.providerIds).toContain('ollama-local');
      expect(cookbook.localCookbook.detected.modelRoutes).toContain('ollama-local:qwen2.5-coder:7b');
      expect(cookbook.localCookbook.detected.stacks).toContain('ollama');
      expect(cookbook.localCookbook.localServerHealth.status).toBe('candidate-endpoints');
      expect(cookbook.localCookbook.localServerHealth.liveProbe).toBe('not-run');
      expect(cookbook.localCookbook.localServerHealth.endpointCount).toBe(1);
      const endpoint = cookbook.localCookbook.localServerHealth.endpoints[0];
      expect(endpoint?.providerId).toBe('ollama-local');
      expect(endpoint?.kind).toBe('local-server-endpoint');
      expect(endpoint?.stack).toBe('ollama');
      expect(endpoint?.baseUrl).toBe('http://127.0.0.1:11434/v1');
      expect(endpoint?.modelsUrl).toBe('http://127.0.0.1:11434/v1/models');
      expect(endpoint?.diagnosticStatus).toBe('registered-route-needs-smoke');
      expect(endpoint?.inspectRoute).toBe(`agent_harness mode:"model_route" modelRouteId:"${endpoint?.id}"`);
      expect(endpoint?.sources).toContain('model-registry');
      expect(endpoint?.sources).toContain('provider-registry');
      expect(endpoint?.sourceDetails).toContain('model:ollama-local:qwen2.5-coder:7b');
      expect(endpoint?.modelRoutes).toContain('ollama-local:qwen2.5-coder:7b');
      expect(endpoint?.smokeCommand).toBe('curl -fsS http://127.0.0.1:11434/v1/models');
      expect(endpoint?.smokeRoute).toContain('models action:"smoke"');
      expect(endpoint?.refreshRoute).toContain('/refresh-models');
      expect(endpoint?.addProviderRoute).toBeNull();
      expect(endpoint?.notes.join('\n')).toContain('Provider already exists');
      expect(endpoint?.servingDiagnostics?.status).toBe('ready');
      expect(endpoint?.servingDiagnostics?.source).toBe('context.platform.readModels.models.servingDiagnostics');
      expect(endpoint?.servingDiagnostics?.schemaStatus).toBe('certified');
      expect(endpoint?.servingDiagnostics?.schemaVersion).toBe('goodvibes.local-serving.v1');
      expect(endpoint?.servingDiagnostics?.provenance?.join('\n')).toContain('models.local.servingDiagnostics');
      expect(endpoint?.servingDiagnostics?.publicationGuarantee).toContain('token=<redacted>');
      expect(endpoint?.servingDiagnostics?.publicationGuarantee).not.toContain('serving-secret');
      expect(endpoint?.servingDiagnostics?.publisher).toBe('goodvibes-daemon');
      expect(endpoint?.servingDiagnostics?.serverVersion).toBe('ollama 0.3.2');
      expect(endpoint?.servingDiagnostics?.loadedModelCount).toBe(1);
      expect(endpoint?.servingDiagnostics?.loadedModels).toEqual(['qwen2.5-coder:7b']);
      expect(endpoint?.servingDiagnostics?.contextWindowTokens).toBe(8192);
      expect(endpoint?.servingDiagnostics?.toolSupport).toBe(true);
      expect(endpoint?.servingDiagnostics?.resourcePressure).toBe('low');
      expect(endpoint?.servingDiagnostics?.resourceSummary).toContain('memory 42%');
      expect(endpoint?.servingDiagnostics?.startReceiptId).toBe('ollama-start-receipt');
      expect(endpoint?.servingDiagnostics?.repairReceiptId).toBe('ollama-repair-receipt');
      expect(endpoint?.servingDiagnostics?.receiptStatus).toBe('ready');
      expect(endpoint?.servingDiagnostics?.startRoute).toContain('agent_operator_method methodId:"models.local.start"');
      expect(endpoint?.servingDiagnostics?.repairRoute).toContain('agent_operator_method methodId:"models.local.repair"');
      expect(endpoint?.servingDiagnostics?.lastCheckedAt).toBe('2026-06-07T10:00:00.000Z');
      expect(endpoint?.servingDiagnostics?.summary).toContain('token=<redacted>');
      expect(endpoint?.servingDiagnostics?.summary).not.toContain('raw-secret');
      expect(endpoint?.servingDiagnostics?.missingSignals).toEqual([]);
      expect(endpoint?.servingDiagnostics?.policy).toContain('exact confirmed routes');
      expect(endpoint?.diagnostics?.successCriteria.join('\n')).toContain('confirmed smoke command exits 0');
      expect(endpoint?.diagnostics?.failureTriage.join('\n')).toContain('start the ollama server');
      expect(endpoint?.diagnostics?.afterSmoke.join('\n')).toContain('refresh route');
      expect(endpoint?.diagnostics?.policy).toContain('models action:"smoke"');
      expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.status).toBe('published-read-model');
      expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.sourcePaths).toContain('context.platform.readModels.models.servingDiagnostics');
      expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.recordCount).toBe(1);
      expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.matchedEndpointCount).toBe(1);
      expect(cookbook.localCookbook.localServerHealth.daemonDiagnostics.missingSignals).toEqual([]);
      expect(cookbook.localCookbook.localServerHealth.nextActions.join('\n')).toContain('Review published local serving diagnostics');
      expect(cookbook.localCookbook.localServerHealth.nextActions.join('\n')).toContain('http://127.0.0.1:11434/v1/models');
      expect(cookbook.localCookbook.localServerHealth.policy).toContain('daemon-published serving diagnostics');

      const endpointDetail = await executeHarnessJson<{
        readonly kind: string;
        readonly modelRouteId: string;
        readonly baseUrl: string;
        readonly modelsUrl: string;
        readonly diagnosticStatus: string;
        readonly smokeCommand: string;
        readonly smokeRoute: string;
        readonly servingDiagnostics?: {
          readonly status: string;
          readonly schemaStatus?: string;
          readonly startRoute?: string;
          readonly repairRoute?: string;
          readonly serverVersion?: string;
          readonly loadedModels: readonly string[];
          readonly summary: string;
        };
        readonly diagnostics?: { readonly successCriteria: readonly string[]; readonly failureTriage: readonly string[]; readonly policy: string };
        readonly modelAccess?: { readonly cookbook: string; readonly smoke: string; readonly addProvider: string | null };
        readonly lookup?: { readonly resolvedBy: string };
      }>(fixture, { mode: 'model_route', modelRouteId: endpoint?.id });
      expect(endpointDetail.kind).toBe('local-server-endpoint');
      expect(endpointDetail.modelRouteId).toBe(endpoint?.id);
      expect(endpointDetail.baseUrl).toBe('http://127.0.0.1:11434/v1');
      expect(endpointDetail.modelsUrl).toBe('http://127.0.0.1:11434/v1/models');
      expect(endpointDetail.diagnosticStatus).toBe('registered-route-needs-smoke');
      expect(endpointDetail.smokeCommand).toBe('curl -fsS http://127.0.0.1:11434/v1/models');
      expect(endpointDetail.smokeRoute).toContain('models action:"smoke"');
      expect(endpointDetail.servingDiagnostics?.status).toBe('ready');
      expect(endpointDetail.servingDiagnostics?.schemaStatus).toBe('certified');
      expect(endpointDetail.servingDiagnostics?.startRoute).toContain('models.local.start');
      expect(endpointDetail.servingDiagnostics?.repairRoute).toContain('models.local.repair');
      expect(endpointDetail.servingDiagnostics?.serverVersion).toBe('ollama 0.3.2');
      expect(endpointDetail.servingDiagnostics?.loadedModels).toEqual(['qwen2.5-coder:7b']);
      expect(endpointDetail.servingDiagnostics?.summary).not.toContain('raw-secret');
      expect(endpointDetail.diagnostics?.successCriteria.join('\n')).toContain('model-list endpoint returns JSON');
      expect(endpointDetail.diagnostics?.failureTriage.join('\n')).toContain('/v1');
      expect(endpointDetail.diagnostics?.policy).toContain('models action:"smoke"');
      expect(endpointDetail.modelAccess?.cookbook).toContain('models action:"local"');
      expect(endpointDetail.modelAccess?.smoke).toBe(endpointDetail.smokeRoute);
      expect(endpointDetail.modelAccess?.addProvider).toBeNull();
      expect(endpointDetail.lookup?.resolvedBy).toBe('local-endpoint-id');
    } finally {
      restoreEnvForTest(previousEndpointEnv);
      fixture.cleanup();
    }
  });

  test('runs confirmed local model smoke against detected endpoint candidates', async () => {
    const previousEndpointEnv = clearEnvForTest(LOCAL_MODEL_ENDPOINT_ENV_KEYS);
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/models') {
          return Response.json({
            object: 'list',
            data: [
              { id: 'qwen2.5-coder:7b', object: 'model' },
              { id: 'llama3.2:3b', object: 'model' },
            ],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    const fixture = makeFixture();
    try {
      const unconfirmed = await fixture.tool.execute({
        mode: 'run_local_model_smoke',
        modelRouteId: `local-127-0-0-1-${server.port}-v1`,
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('requires explicitUserRequest');

      const smoke = await executeHarnessJson<{
        readonly kind: string;
        readonly status: string;
        readonly liveProbe: string;
        readonly endpointCount: number;
        readonly passedCount: number;
        readonly failedCount: number;
        readonly endpoints: readonly {
          readonly kind: string;
          readonly id: string;
          readonly status: string;
          readonly liveProbe: string;
          readonly networkScope: string;
          readonly modelsUrl: string;
          readonly httpStatus: number;
          readonly jsonValid: boolean;
          readonly modelCount: number;
          readonly sampleModelIds: readonly string[];
          readonly success: boolean;
          readonly refreshRoute: string;
          readonly addProviderRoute: string | null;
        }[];
        readonly policy: string;
      }>(fixture, {
        mode: 'run_local_model_smoke',
        modelRouteId: `local-127-0-0-1-${server.port}-v1`,
        timeoutMs: 1000,
        confirm: true,
        explicitUserRequest: 'Check local model servers.',
      });

      expect(smoke.kind).toBe('local-model-smoke');
      expect(smoke.status).toBe('ready');
      expect(smoke.liveProbe).toBe('confirmed');
      expect(smoke.endpointCount).toBe(1);
      expect(smoke.passedCount).toBe(1);
      expect(smoke.failedCount).toBe(0);
      const endpoint = smoke.endpoints[0];
      expect(endpoint?.kind).toBe('local-server-endpoint');
      expect(endpoint?.status).toBe('passed');
      expect(endpoint?.liveProbe).toBe('confirmed');
      expect(endpoint?.networkScope).toBe('loopback');
      expect(endpoint?.modelsUrl).toBe(`http://127.0.0.1:${server.port}/v1/models`);
      expect(endpoint?.httpStatus).toBe(200);
      expect(endpoint?.jsonValid).toBe(true);
      expect(endpoint?.modelCount).toBe(2);
      expect(endpoint?.sampleModelIds).toContain('qwen2.5-coder:7b');
      expect(endpoint?.success).toBe(true);
      expect(endpoint?.refreshRoute).toContain('/refresh-models');
      expect(endpoint?.addProviderRoute).toContain('/provider add');
      expect(smoke.policy).toContain('Confirmed read-only local model smoke');
      expect(smoke.policy).toContain('does not add providers');
    } finally {
      server.stop();
      restoreEnvForTest(previousEndpointEnv);
      fixture.cleanup();
    }
  });

  test('reports every model a local endpoint advertises, not just the ones it prints', async () => {
    const previousEndpointEnv = clearEnvForTest(LOCAL_MODEL_ENDPOINT_ENV_KEYS);
    const advertised = 20;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/v1/models') {
          return Response.json({
            object: 'list',
            data: Array.from({ length: advertised }, (_value, index) => ({ id: `model-${index}`, object: 'model' })),
          });
        }
        return new Response('not found', { status: 404 });
      },
    });
    process.env.OLLAMA_BASE_URL = `http://127.0.0.1:${server.port}/v1`;
    const fixture = makeFixture();
    try {
      const smoke = await executeHarnessJson<{
        readonly endpointCount: number;
        readonly candidateEndpointCount: number;
        readonly note?: string;
        readonly endpoints: readonly {
          readonly modelCount: number;
          readonly sampleModelIds: readonly string[];
        }[];
      }>(fixture, {
        mode: 'run_local_model_smoke',
        modelRouteId: `local-127-0-0-1-${server.port}-v1`,
        timeoutMs: 1000,
        confirm: true,
        explicitUserRequest: 'Check local model servers.',
      });

      // modelCount used to be read off the 12-entry capped list, so a server
      // advertising 20 models reported 12.
      expect(smoke.endpoints[0]?.modelCount).toBe(advertised);
      expect(smoke.endpoints[0]?.sampleModelIds).toHaveLength(5);
      // Every endpoint that existed was probed, so nothing claims otherwise.
      expect(smoke.candidateEndpointCount).toBe(smoke.endpointCount);
      expect(smoke.note).toBeUndefined();
    } finally {
      server.stop();
      restoreEnvForTest(previousEndpointEnv);
      fixture.cleanup();
    }
  });

  test('surfaces saved local model benchmark history in cookbook and setup', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-cmp_local.json',
      text: '{}',
      metadata: {
        purpose: 'agent-model-compare',
        benchmarkKind: 'local-model-route',
        comparisonId: 'cmp_local',
        promptPreview: 'local model benchmark: Ollama',
        candidateCount: 2,
        completedCandidates: 2,
        candidateLatencyEvidence: [
          {
            blindId: 'A',
            status: 'completed',
            latencyMs: 642,
            registryKey: 'ollama:qwen2.5-coder:7b',
            providerId: 'ollama',
            modelId: 'qwen2.5-coder:7b',
            displayName: 'Qwen local',
          },
          {
            blindId: 'B',
            status: 'completed',
            latencyMs: 1280,
            registryKey: 'openai:gpt-4.1',
            providerId: 'openai',
            modelId: 'gpt-4.1',
            displayName: 'GPT 4.1',
          },
        ],
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-cmp_other.json',
      text: '{}',
      metadata: {
        purpose: 'agent-model-compare',
        comparisonId: 'cmp_other',
        promptPreview: 'Write a concise product update.',
        candidateCount: 2,
        completedCandidates: 2,
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-judgment-jdg_local.json',
      text: '{}',
      metadata: {
        purpose: 'agent-model-compare-judgment',
        judgmentId: 'jdg_local',
        comparisonId: 'cmp_local',
        sourceArtifactId: 'artifact-1',
        winnerBlindId: 'A',
        promptPreview: 'local model benchmark: Ollama',
        revealIncludedInJudgment: true,
        winnerModel: 'ollama:qwen2.5-coder:7b',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const cookbook = await executeHarnessJson<{
        readonly localCookbook: {
          readonly benchmarkHistory?: {
            readonly status: string;
            readonly count: number;
            readonly nextAction?: string;
            readonly analyticsRoute?: string;
            readonly evidence?: {
              readonly status: string;
              readonly confidence: string;
              readonly comparisonCount: number;
              readonly revealedJudgmentCount: number;
              readonly winnerStacks: readonly string[];
              readonly routeLatencies?: readonly { readonly registryKey: string; readonly latencyMs: number; readonly artifactId: string }[];
              readonly winnerModels: readonly { readonly registryKey: string; readonly stack?: string | null; readonly applyRoute: string }[];
            };
            readonly artifacts: readonly {
              readonly artifactId: string;
              readonly comparisonId?: string | null;
              readonly promptPreview?: string;
              readonly completedCandidates?: number | null;
              readonly reviewRoute: string;
              readonly revealRoute: string;
            }[];
            readonly judgments?: readonly {
              readonly artifactId: string;
              readonly winnerModel?: string | null;
              readonly winnerStack?: string | null;
              readonly applyRoute?: string | null;
            }[];
          };
          readonly recipes?: readonly {
            readonly id: string;
            readonly readiness?: {
              readonly confidence?: string;
              readonly missingSignals?: readonly string[];
              readonly nextStep?: string;
            };
          }[];
        };
      }>(fixture, { mode: 'model_routing', query: 'local', includeParameters: true });

      expect(cookbook.localCookbook.benchmarkHistory?.status).toBe('history-found');
      expect(cookbook.localCookbook.benchmarkHistory?.count).toBe(1);
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts.map((artifact) => artifact.artifactId)).toEqual(['artifact-1']);
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.comparisonId).toBe('cmp_local');
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.completedCandidates).toBe(2);
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.reviewRoute).toContain('agent_model_compare review');
      expect(cookbook.localCookbook.benchmarkHistory?.artifacts[0]?.revealRoute).toContain('agent_model_compare reveal');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.artifactId).toBe('artifact-3');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.winnerModel).toBe('ollama:qwen2.5-coder:7b');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.winnerStack).toBe('ollama');
      expect(cookbook.localCookbook.benchmarkHistory?.judgments?.[0]?.applyRoute).toContain('agent_model_compare apply');
      expect(cookbook.localCookbook.benchmarkHistory?.evidence).toMatchObject({
        status: 'reviewed-winner',
        confidence: 'measured',
        comparisonCount: 1,
        revealedJudgmentCount: 1,
      });
      expect(cookbook.localCookbook.benchmarkHistory?.evidence?.winnerStacks).toContain('ollama');
      expect(cookbook.localCookbook.benchmarkHistory?.evidence?.winnerModels[0]?.registryKey).toBe('ollama:qwen2.5-coder:7b');
      expect(cookbook.localCookbook.benchmarkHistory?.evidence?.routeLatencies?.find((entry) => entry.registryKey === 'ollama:qwen2.5-coder:7b')).toMatchObject({
        latencyMs: 642,
        artifactId: 'artifact-1',
      });
      expect(cookbook.localCookbook.benchmarkHistory?.nextAction).toContain('revealed saved judgment');
      expect(cookbook.localCookbook.benchmarkHistory?.analyticsRoute).toContain('agent_model_compare analytics');
      expect(cookbook.localCookbook.benchmarkHistory?.analyticsRoute).toContain('benchmarkKind:"local-model-route"');
      const ollamaRecipe = cookbook.localCookbook.recipes?.find((recipe) => recipe.id === 'ollama');
      expect(ollamaRecipe?.readiness?.confidence).toBe('measured');
      expect(ollamaRecipe?.readiness?.missingSignals?.join('\n')).not.toContain('No live latency benchmark');
      expect(ollamaRecipe?.readiness?.nextStep).toContain('saved benchmark judgment');

      const setup = await executeHarnessJson<{
        readonly setupItemId: string;
        readonly localModelReadiness?: {
          readonly benchmarkHistory?: {
            readonly status: string;
            readonly artifacts: readonly { readonly artifactId: string }[];
            readonly evidence?: { readonly status: string; readonly winnerStacks: readonly string[] };
          };
        };
      }>(fixture, { mode: 'setup_item', setupItemId: 'local-model-readiness' });
      expect(setup.setupItemId).toBe('local-model-readiness');
      expect(setup.localModelReadiness?.benchmarkHistory?.status).toBe('history-found');
      expect(setup.localModelReadiness?.benchmarkHistory?.artifacts.map((artifact) => artifact.artifactId)).toEqual(['artifact-1']);
      expect(setup.localModelReadiness?.benchmarkHistory?.evidence?.status).toBe('reviewed-winner');
      expect(setup.localModelReadiness?.benchmarkHistory?.evidence?.winnerStacks).toContain('ollama');
    } finally {
      fixture.cleanup();
    }
  });

  test('scores model route readiness from provider metadata without hiding missing benchmarks', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'blind-model-comparison-cmp_latency.json',
      text: '{}',
      metadata: {
        purpose: 'agent-model-compare',
        benchmarkKind: 'local-model-route',
        comparisonId: 'cmp_latency',
        promptPreview: 'local model benchmark: Ollama route latency',
        candidateCount: 2,
        completedCandidates: 2,
        candidateLatencyEvidence: [
          {
            blindId: 'A',
            status: 'completed',
            latencyMs: 642,
            registryKey: 'ollama:qwen2.5-coder:7b',
            providerId: 'ollama',
            modelId: 'qwen2.5-coder:7b',
            displayName: 'Qwen local',
          },
          {
            blindId: 'B',
            status: 'completed',
            latencyMs: 1220,
            registryKey: 'openai:gpt-4.1',
            providerId: 'openai',
            modelId: 'gpt-4.1',
            displayName: 'GPT 4.1',
          },
        ],
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      const cloudModel = {
        registryKey: 'openai:gpt-4.1',
        modelId: 'gpt-4.1',
        providerId: 'openai',
        displayName: 'GPT 4.1',
        current: true,
        contextWindow: 128_000,
        reasoningEffort: ['low', 'medium', 'high'],
        capabilities: {
          toolCalling: true,
          codeEditing: true,
          reasoning: true,
          multimodal: true,
        },
        tier: 'premium',
        benchmark: {
          compositeScore: 0.82,
          qualityTier: 'S',
        },
      };
      const localModel = {
        registryKey: 'ollama:qwen2.5-coder:7b',
        modelId: 'qwen2.5-coder:7b',
        providerId: 'ollama',
        displayName: 'Qwen local',
        current: false,
        contextWindow: 32_768,
        reasoningEffort: [],
        capabilities: {
          toolCalling: false,
          codeEditing: true,
          reasoning: false,
          multimodal: false,
        },
        tier: 'free',
      };
      (fixture.context.clients as Record<string, unknown>).providerApi = {
        getFavorites: async () => ({ pinned: [cloudModel], recent: [] }),
        getCurrentModel: async () => cloudModel,
        listModels: async () => [cloudModel, localModel],
        listProviderIds: () => ['openai', 'ollama'],
      };

      const routing = await executeHarnessJson<{
        readonly current: {
          readonly currentModel?: {
            readonly readiness?: { readonly score: number; readonly dimensions: readonly { readonly id: string }[] };
            readonly benchmarkCompositeScore?: number | null;
          } | null;
        };
        readonly models: readonly {
          readonly modelRouteId: string;
          readonly tier?: string | null;
          readonly benchmarkCompositeScore?: number | null;
          readonly localBenchmarkLatency?: { readonly latencyMs: number; readonly artifactId: string } | null;
          readonly readinessScore?: number;
          readonly readinessLevel?: string;
          readonly readiness?: {
            readonly score: number;
            readonly level: string;
            readonly confidence: string;
            readonly dimensions: readonly { readonly id: string; readonly score: number; readonly summary?: string }[];
            readonly missingSignals: readonly string[];
            readonly providerHealth: {
              readonly status: string;
              readonly sdkContract: {
                readonly providerHealthTypes: string;
                readonly importSurface: string;
              };
              readonly daemonPublication: {
                readonly status: string;
                readonly requiredPath: string;
              };
              readonly agentConsumption: {
                readonly status: string;
                readonly readModelPath: string | null;
              };
              readonly healthStatus?: string;
              readonly avgLatencyMs?: number;
              readonly missingSignals: readonly string[];
            };
            readonly nextStep: string;
          };
        }[];
      }>(fixture, { mode: 'model_routing', includeParameters: true, limit: 10 });

      expect(routing.current.currentModel?.benchmarkCompositeScore).toBe(0.82);
      expect(routing.current.currentModel?.readiness?.dimensions.map((dimension) => dimension.id)).toEqual([
        'latency',
        'context-window',
        'tool-support',
        'vision',
        'cost',
        'privacy',
      ]);
      const cloud = routing.models.find((model) => model.modelRouteId === 'openai:gpt-4.1');
      expect(cloud?.tier).toBe('premium');
      expect(cloud?.benchmarkCompositeScore).toBe(0.82);
      expect(cloud?.localBenchmarkLatency).toMatchObject({
        latencyMs: 1220,
        artifactId: 'artifact-1',
      });
      expect(cloud?.readinessScore).toBeGreaterThan(0);
      expect(cloud?.readinessLevel).toBeTruthy();
      expect(cloud?.readiness?.dimensions.find((dimension) => dimension.id === 'tool-support')?.score).toBe(100);
      expect(cloud?.readiness?.dimensions.find((dimension) => dimension.id === 'vision')?.score).toBe(100);
      expect(cloud?.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('Measured local benchmark latency is 1220 ms');
      expect(cloud?.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(cloud?.readiness?.providerHealth.status).toBe('not-reachable-in-command-context');
      expect(cloud?.readiness?.providerHealth.sdkContract.providerHealthTypes).toBe('available');
      expect(cloud?.readiness?.providerHealth.sdkContract.importSurface).toBe('@goodvibes-jev/engine/sdk/platform/runtime/ui');
      expect(cloud?.readiness?.providerHealth.daemonPublication.status).toBe('not-published');
      expect(cloud?.readiness?.providerHealth.daemonPublication.requiredPath).toBe('context.platform.readModels.providerHealth');
      expect(cloud?.readiness?.providerHealth.agentConsumption.status).toBe('waiting-for-published-feed');
      expect(cloud?.readiness?.providerHealth.missingSignals.join('\n')).toContain('SDK provider-health types are available');
      expect(cloud?.readiness?.nextStep).toContain('provider-health publication');

      const local = routing.models.find((model) => model.modelRouteId === 'ollama:qwen2.5-coder:7b');
      expect(local?.localBenchmarkLatency).toMatchObject({
        latencyMs: 642,
        artifactId: 'artifact-1',
      });
      expect(local?.readiness?.dimensions.find((dimension) => dimension.id === 'privacy')?.score).toBe(100);
      expect(local?.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('Measured local benchmark latency is 642 ms');
      expect(local?.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(local?.readiness?.nextStep).toContain('artifact-1');

      const inspected = await executeHarnessJson<{
        readonly modelRouteId: string;
        readonly localBenchmarkLatency?: { readonly latencyMs: number; readonly artifactId: string } | null;
        readonly readiness?: {
          readonly confidence: string;
          readonly dimensions: readonly { readonly id: string; readonly summary?: string }[];
          readonly missingSignals: readonly string[];
          readonly providerHealth: {
            readonly status: string;
            readonly agentConsumption: { readonly status: string };
            readonly missingSignals: readonly string[];
          };
        };
      }>(fixture, { mode: 'model_route', modelRouteId: 'ollama:qwen2.5-coder:7b' });
      expect(inspected.modelRouteId).toBe('ollama:qwen2.5-coder:7b');
      expect(inspected.localBenchmarkLatency).toMatchObject({
        latencyMs: 642,
        artifactId: 'artifact-1',
      });
      expect(inspected.readiness?.dimensions.map((dimension) => dimension.id)).toContain('cost');
      expect(inspected.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('Measured local benchmark latency');
      expect(inspected.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(inspected.readiness?.providerHealth.status).toBe('not-reachable-in-command-context');
      expect(inspected.readiness?.providerHealth.agentConsumption.status).toBe('waiting-for-published-feed');

      (fixture.context.platform as unknown as Record<string, unknown>).readModels = {
        modelRouteHealth: {
          getSnapshot: () => ({
            routes: new Map([[
              'openai:gpt-4.1',
              {
                recordId: 'route-health-openai-gpt4',
                modelRouteId: 'openai:gpt-4.1',
                providerId: 'openai',
                status: 'healthy',
                isConfigured: true,
                isActive: true,
                stats: {
                  avgLatencyMs: 321,
                  minLatencyMs: 200,
                  maxLatencyMs: 650,
                  lastSuccessAt: Date.UTC(2026, 0, 2, 3, 4, 5),
                  lastCheckedAt: '2026-01-02T03:05:00.000Z',
                },
                rateLimit: {
                  remaining: 4900,
                  limit: 5000,
                  resetAt: '2026-01-02T04:00:00.000Z',
                },
                errors: {
                  errorRate: 0,
                  consecutiveErrors: 0,
                  lastErrorMessage: 'prior transient 429 token=provider-secret',
                },
              },
            ]]),
          }),
        },
      };
      const healthBacked = await executeHarnessJson<{
        readonly modelRouteId: string;
        readonly readiness?: {
          readonly confidence: string;
          readonly dimensions: readonly { readonly id: string; readonly score: number; readonly summary: string }[];
          readonly missingSignals: readonly string[];
          readonly providerHealth: {
            readonly status: string;
            readonly healthStatus?: string;
            readonly modelRouteId?: string;
            readonly sourceRecordId?: string;
            readonly avgLatencyMs?: number;
            readonly rateLimitRemaining?: number;
            readonly rateLimitResetAt?: string | null;
            readonly lastErrorMessage?: string;
            readonly agentConsumption: { readonly status: string; readonly readModelPath: string | null };
            readonly daemonPublication: { readonly status: string };
          };
        };
      }>(fixture, { mode: 'model_route', modelRouteId: 'openai:gpt-4.1' });
      expect(healthBacked.modelRouteId).toBe('openai:gpt-4.1');
      expect(healthBacked.readiness?.confidence).toBe('provider-health-backed');
      expect(healthBacked.readiness?.missingSignals.join('\n')).not.toContain('No live latency benchmark');
      expect(healthBacked.readiness?.providerHealth.status).toBe('record-found');
      expect(healthBacked.readiness?.providerHealth.healthStatus).toBe('healthy');
      expect(healthBacked.readiness?.providerHealth.modelRouteId).toBe('openai:gpt-4.1');
      expect(healthBacked.readiness?.providerHealth.sourceRecordId).toBe('route-health-openai-gpt4');
      expect(healthBacked.readiness?.providerHealth.avgLatencyMs).toBe(321);
      expect(healthBacked.readiness?.providerHealth.rateLimitRemaining).toBe(4900);
      expect(healthBacked.readiness?.providerHealth.rateLimitResetAt).toBe('2026-01-02T04:00:00.000Z');
      expect(healthBacked.readiness?.providerHealth.lastErrorMessage).toContain('token=<redacted>');
      expect(healthBacked.readiness?.providerHealth.lastErrorMessage).not.toContain('provider-secret');
      expect(healthBacked.readiness?.providerHealth.agentConsumption.status).toBe('consumed');
      expect(healthBacked.readiness?.providerHealth.agentConsumption.readModelPath).toBe('context.platform.readModels.modelRouteHealth');
      expect(healthBacked.readiness?.providerHealth.daemonPublication.status).toBe('published-read-model');
      expect(healthBacked.readiness?.dimensions.find((dimension) => dimension.id === 'latency')?.summary).toContain('Live provider-health latency');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes Agent workspace categories, actions, and editor schemas to the model', async () => {
    const fixture = makeFixture();
    try {
      const workspace = await fixture.tool.execute({ mode: 'workspace' });
      expect(workspace.success).toBe(true);
      const workspacePayload = JSON.parse(workspace.output!) as {
        readonly categories: readonly { readonly id: string; readonly actions: number }[];
        readonly actions: number;
      };
      expect(workspacePayload.categories.find((entry) => entry.id === 'home')?.actions).toBeGreaterThan(0);
      expect(workspacePayload.categories.find((entry) => entry.id === 'personal-ops')?.actions).toBeGreaterThan(0);
      expect(workspacePayload.categories.find((entry) => entry.id === 'documents')?.actions).toBeGreaterThan(0);
      expect(workspacePayload.actions).toBeGreaterThan(0);
      expectCompactSummaryFields(workspacePayload);

      const categories = await fixture.tool.execute({ mode: 'workspace_categories' });
      expect(categories.success).toBe(true);
      const categoryPayload = JSON.parse(categories.output!) as {
        readonly categories: readonly { readonly id: string; readonly actions: number }[];
        readonly actions: number;
      };
      expect(categoryPayload.categories.find((entry) => entry.id === 'memory')?.actions).toBeGreaterThan(0);
      expect(categoryPayload.actions).toBe(workspacePayload.actions);
      expectCompactSummaryFields(categoryPayload);

      const compactSummary = await fixture.tool.execute({ mode: 'summary' });
      expect(compactSummary.success).toBe(true);
      const compactSummaryJson = JSON.parse(compactSummary.output ?? '{}') as { readonly modelAccess?: unknown };
      expect(compactSummaryJson.modelAccess).toBeUndefined();

      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly workspace?: string; readonly documentOps?: string } };
      expect(summaryJson.modelAccess?.workspace).toContain('workspace action:"status');
      expect(summaryJson.modelAccess?.workspace).toContain('|actions');
      expect(summaryJson.modelAccess?.documentOps).toContain('mode:"document_ops"');

      const listed = await fixture.tool.execute({ mode: 'workspace_actions', query: 'memory create' });
      expect(listed.success).toBe(true);
      expect(listed.output).toContain('memory-create');
      expect(listed.output).toContain('Create memory');
      const listedPayload = JSON.parse(listed.output!) as {
        readonly actions: readonly { readonly id: string; readonly modelRoute?: string }[];
      };
      expectCompactSummaryFields(listedPayload);
      expect(listedPayload.actions.find((entry) => entry.id === 'memory-create')?.modelRoute).toBe('agent_local_registry');

      const allActions = await fixture.tool.execute({ mode: 'workspace_actions' });
      expect(allActions.success).toBe(true);
      const allActionPayload = JSON.parse(allActions.output!) as {
        readonly actions: readonly { readonly id: string; readonly modelRoute?: string }[];
        readonly returned: number;
        readonly total: number;
      };
      expect(allActionPayload.returned).toBe(workspacePayload.actions);
      expect(allActionPayload.total).toBe(workspacePayload.actions);
      expect(allActionPayload.actions.length).toBe(workspacePayload.actions);
      expect(allActionPayload.actions.filter((entry) => (
        typeof entry.modelRoute !== 'string'
        || entry.modelRoute.length === 0
        || entry.modelRoute.length > 72
      ))).toEqual([]);
      expect(allActionPayload.actions.find((entry) => entry.id === 'assistant-personal-ops-lane')?.modelRoute).toBe('workspace action:"open"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-briefing')?.modelRoute).toBe('personal_ops action:"briefing"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-queue')?.modelRoute).toBe('personal_ops action:"queue"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-intake')?.modelRoute).toBe('personal_ops action:"intake"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'personal-ops-autonomy-queue')?.modelRoute).toBe('autonomy action:"queue"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'voice-workflow-posture')?.modelRoute).toBe('device action:"voice"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'device-capability-map')?.modelRoute).toBe('device action:"status"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'assistant-research-docs-lane')?.modelRoute).toBe('workspace action:"open"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-create-draft')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-revise-draft')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-comment-draft')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-resolve-comment')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-suggest-draft')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-accept-suggestion')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-reject-suggestion')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-insert-artifact')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-attach-artifact')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-draft')?.modelRoute).toBe('agent_documents');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-save-review-packet-preset')?.modelRoute).toBe('agent_review_packet_presets');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-refresh-review-packet-preset')?.modelRoute).toBe('agent_review_packet_presets');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-share-review-packet')?.modelRoute).toBe('agent_review_packet_share');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-browse-artifacts')?.modelRoute).toBe('agent_artifacts');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-artifact-file')?.modelRoute).toBe('agent_artifacts');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-artifact-package')?.modelRoute).toBe('agent_artifacts');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-promote-artifact')?.modelRoute).toBe('agent_knowledge_ingest');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-ingest-file')?.modelRoute).toBe('agent_knowledge_ingest');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-generate-media')?.modelRoute).toBe('agent_media_generate');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-run-compare')?.modelRoute).toBe('agent_model_compare');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-review-compare')?.modelRoute).toBe('agent_model_compare');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-judge-compare')?.modelRoute).toBe('agent_model_compare');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-compare-analytics')?.modelRoute).toBe('agent_model_compare');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-apply-compare')?.modelRoute).toBe('agent_model_compare');
      expect(allActionPayload.actions.find((entry) => entry.id === 'document-export-compare')?.modelRoute).toBe('agent_model_compare');
      expect(allActionPayload.actions.find((entry) => entry.id === 'knowledge-ingest-url')?.modelRoute).toBe('agent_knowledge_ingest');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-briefing')?.modelRoute).toBe('research action:"briefing"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-workflow-plan')?.modelRoute).toBe('research action:"plan"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-runner-readiness')?.modelRoute).toBe('research action:"runner"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'work-background-processes')?.modelRoute).toBe('execution action:"processes"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'work-process-capabilities')?.modelRoute).toBe('process action:"capabilities"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-run-queue')?.modelRoute).toBe('research action:"runs"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-public-search')?.modelRoute).toBe('research action:"search"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-start-run')?.modelRoute).toBe('research action:"create_run"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-source-queue')?.modelRoute).toBe('research action:"sources"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-add-source')?.modelRoute).toBe('research action:"add_source"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-report-artifacts')?.modelRoute).toBe('research action:"reports"');
      expect(allActionPayload.actions.find((entry) => entry.id === 'research-save-report')?.modelRoute).toBe('research action:"report"');

      const listedWithEditors = await fixture.tool.execute({ mode: 'workspace_actions', query: 'memory create', includeParameters: true });
      expect(listedWithEditors.success).toBe(true);
      expect(listedWithEditors.output).toContain('"editor"');
      expect(listedWithEditors.output).toContain('"summary"');

      const action = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'memory-create' });
      expect(action.success).toBe(true);
      expect(action.output).toContain('"editorKind": "memory"');
      expect(action.output).toContain('agent_local_registry');
      expect(action.output).toContain('"route": "agent_local_registry"');
      expect(action.output).toContain('"summary"');
    } finally {
      fixture.cleanup();
    }
  });

  // DELETED: 'inspects one workspace action from command, target, query, and action id lookups'
  // memory-list action was removed from the workspace.;

  test('uses runtime context for model-visible profile and routine schedule editor schemas', async () => {
    const fixture = makeFixture();
    try {
      const routine = AgentRoutineRegistry.fromShellPaths(fixture.paths).create({
        name: 'Morning Review',
        description: 'Review current operator state.',
        steps: 'Check work plan, approvals, schedules, and Agent Knowledge status.',
        enabled: true,
      });

      const profileAction = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'runtime-profile-create' });
      expect(profileAction.success).toBe(true);
      expect(profileAction.output).toContain('Starter template');

      const routineAction = await fixture.tool.execute({
        mode: 'workspace_action',
        actionId: 'schedule-promote-routine',
        recordId: routine.id,
      });
      expect(routineAction.success).toBe(true);
      expect(routineAction.output).toContain(`Selected: ${routine.id} (${routine.name})`);
      expect(routineAction.output).toContain(`"default": "${routine.id}"`);
      expect(routineAction.output).toContain(`"default": "${routine.name}"`);

      const scheduleEditAction = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'schedule-edit' });
      expect(scheduleEditAction.success).toBe(true);
      expect(scheduleEditAction.output).toContain('"editorKind": "schedule-edit"');
      expect(scheduleEditAction.output).toContain('"modelRoute": "schedule action:\\"edit\\""');
      expect(scheduleEditAction.output).toContain('"id": "scheduleId"');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes command policy metadata for slash-command mirror coverage', async () => {
    const fixture = makeFixture();
    try {
      registerOperatorRuntimeCommands(fixture.commandRegistry);

      const settings = await fixture.tool.execute({ mode: 'command', commandName: 'settings' });
      expect(settings.success).toBe(true);
      const settingsJson = JSON.parse(settings.output ?? '{}') as {
        readonly policy?: {
          readonly effect?: string;
          readonly preferredModelTool?: string;
          readonly boundary?: string;
        };
      };
      expect(settingsJson.policy?.effect).toBe('mixed');
      expect(settingsJson.policy?.preferredModelTool).toBe('settings action:"list"|action:"get"|action:"set"|action:"reset"|action:"import"');
      expect(settingsJson.policy?.preferredModelTool).not.toContain('settings/get_setting/set_setting/reset_setting');
      // The boundary told the model that connected-host lifecycle/listener
      // settings were read-only. That stopped being true when those keys became
      // daemon-owned and their writes started routing to the daemon, so the text
      // now describes routing plus the confirmation gate that replaced the lock.
      expect(settingsJson.policy?.boundary).toContain('routes to the runtime that owns the key');
      expect(settingsJson.policy?.boundary).toContain('needs the user to ask first');
      expect(settingsJson.policy?.boundary).not.toContain('remain read-only');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes every built-in slash command through the model-facing command catalog', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const catalog = await fixture.tool.execute({ mode: 'commands', includeParameters: true, limit: 500 });
      expect(catalog.success).toBe(true);
      if (!catalog.success) throw new Error(catalog.error);
      const payload = JSON.parse(catalog.output!) as {
        readonly commands: readonly {
          readonly name: string;
          readonly slash: string;
          readonly policy?: {
            readonly effect?: string;
            readonly preferredModelTool?: string;
          };
        }[];
        readonly returned: number;
        readonly total: number;
      };
      const registeredNames = fixture.commandRegistry.list().map((command) => command.name).sort();
      const catalogNames = payload.commands.map((command) => command.name).sort();

      expect(payload.total).toBe(registeredNames.length);
      expect(payload.returned).toBe(registeredNames.length);
      expect(catalogNames).toEqual(registeredNames);
      expect(catalogNames).toEqual(expect.arrayContaining([
        'agent',
        'agent-profile',
        'channels',
        'commands',
        'knowledge',
        'memory',
        'model',
        'qrcode',
        'schedule',
        'settings',
        'tasks',
        'voice',
        'work',
      ]));
      for (const hidden of [
        'bridge',
        'daemon',
        'panel',
        'profiles',
        'remote',
        'services',
      ] as const) {
        expect(catalogNames).not.toContain(hidden);
      }
      expect(payload.commands.map((command) => command.slash)).toEqual(payload.commands.map((command) => `/${command.name}`));
      expect(payload.commands.filter((command) => !command.policy?.effect || !command.policy.preferredModelTool)).toEqual([]);
      expectModelFacingText(catalog.output!);

      const compactCatalog = await fixture.tool.execute({ mode: 'commands', limit: 500 });
      expect(compactCatalog.success).toBe(true);
      if (!compactCatalog.success) throw new Error(compactCatalog.error);
      const compactPayload = JSON.parse(compactCatalog.output!) as {
        readonly commands: readonly { readonly effect?: string; readonly modelRoute?: string }[];
      };
      expectCompactSummaryFields(compactPayload);
      expect(compactPayload.commands.filter((command) => !command.effect || !command.modelRoute)).toEqual([]);
      expect(compactPayload.commands.filter((command) => (command.modelRoute?.length ?? 0) > 72)).toEqual([]);

      const profileAlias = await fixture.tool.execute({ mode: 'command', command: '/agent-profiles list' });
      expect(profileAlias.success).toBe(true);
      if (!profileAlias.success) throw new Error(profileAlias.error);
      const profilePayload = JSON.parse(profileAlias.output!) as {
        readonly name: string;
        readonly lookup: { readonly resolvedBy: string; readonly parsedArgs: readonly string[] };
        readonly policy?: { readonly preferredModelTool?: string };
      };
      expect(profilePayload.name).toBe('agent-profile');
      expect(profilePayload.lookup.resolvedBy).toBe('alias');
      expect(profilePayload.lookup.parsedArgs).toEqual(['list']);
      expect(profilePayload.policy?.preferredModelTool).toContain('workspace_actions');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes first-class model tool schemas individually', async () => {
    const fixture = makeFixture();
    try {
      const tool: Tool = {
        definition: {
          name: 'agent_custom_action',
          description: 'Run a confirmed custom Agent action',
          sideEffects: ['state'],
          concurrency: 'serial',
          supportsProgress: true,
          parameters: {
            type: 'object',
            properties: {
              targetId: { type: 'string', description: 'Target record id.' },
              confirm: { type: 'boolean' },
            },
            required: ['targetId'],
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'custom action executed' }),
      };
      fixture.toolRegistry.register(tool);
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_custom_report',
          description: 'Inspect a custom Agent report',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'custom report inspected' }),
      });
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_a_notice_template',
          description: 'Inspect notice template before send',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'notice template inspected' }),
      });
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_z_send_notice',
          description: 'Send one confirmed notice to a configured target',
          sideEffects: ['network'],
          parameters: {
            type: 'object',
            properties: {
              message: { type: 'string', description: 'Notice body.' },
              targetId: { type: 'string', description: 'Configured delivery target id.' },
              confirm: { type: 'boolean' },
            },
            required: ['message', 'targetId', 'confirm'],
            additionalProperties: false,
          },
        },
        execute: async () => ({ success: true, output: 'notice sent' }),
      });
      compactRegisteredToolDefinitions(fixture.toolRegistry);

      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly tools?: string } };
      expect(summaryJson.modelAccess?.tools).toContain('mode:"tool"');
      expect(summaryJson.modelAccess?.tools).toContain('includeParameters:true');

      const catalog = await fixture.tool.execute({ mode: 'tools', query: 'custom' });
      expect(catalog.success).toBe(true);
      expect(catalog.output).toContain('"name": "agent_custom_action"');
      expect(catalog.output).toContain('"supportsProgress": true');
      expect(catalog.output).not.toContain('"targetId"');
      const catalogJson = JSON.parse(catalog.output ?? '{}') as {
        readonly tools: readonly { readonly summary?: string }[];
      };
      expect(catalogJson.tools.filter((entry) => (entry.summary?.length ?? 0) > 72)).toEqual([]);

      const catalogWithSchemas = await fixture.tool.execute({ mode: 'tools', query: 'confirmed custom Agent action', includeParameters: true });
      expect(catalogWithSchemas.success).toBe(true);
      expect(catalogWithSchemas.output).toContain('"parameters"');
      expect(catalogWithSchemas.output).toContain('"targetId"');

      const taskPhraseCatalog = await fixture.tool.execute({ mode: 'tools', query: 'send notice' });
      expect(taskPhraseCatalog.success).toBe(true);
      const taskPhraseJson = JSON.parse(taskPhraseCatalog.output ?? '{}') as {
        readonly tools: readonly { readonly name: string }[];
      };
      expect(taskPhraseJson.tools[0]?.name).toBe('agent_z_send_notice');

      const parameterCatalog = await fixture.tool.execute({ mode: 'tools', query: 'target id' });
      expect(parameterCatalog.success).toBe(true);
      expect(parameterCatalog.output).toContain('"name": "agent_custom_action"');

      const detail = await fixture.tool.execute({ mode: 'tool', toolName: 'agent_custom_action' });
      expect(detail.success).toBe(true);
      expect(detail.output).toContain('"name": "agent_custom_action"');
      expect(detail.output).toContain('"resolvedBy": "name"');
      expect(detail.output).toContain('"concurrency": "serial"');
      expect(detail.output).toContain('"targetId"');
      expect(detail.output).toContain('Use the returned JSON schema directly');

      const targetLookup = await fixture.tool.execute({ mode: 'tool', target: 'confirmed custom Agent action' });
      expect(targetLookup.success).toBe(true);
      expect(targetLookup.output).toContain('"name": "agent_custom_action"');
      expect(targetLookup.output).toContain('"source": "target"');
      expect(targetLookup.output).toContain('"resolvedBy": "search"');

      const ambiguous = await fixture.tool.execute({ mode: 'tool', query: 'custom Agent' });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous model tool custom Agent');
      expect(ambiguous.error).toContain('agent_custom_action');
      expect(ambiguous.error).toContain('agent_custom_report');

      const missing = await fixture.tool.execute({ mode: 'tool', toolName: 'not_a_tool' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown model tool');
      // The names of the real, registered tools are right there in the
      // refusal, not a pointer to go look them up somewhere else.
      expect(missing.error).toContain('Known tools:');

      // The exact incident, with no "mcp" tool registered: the refusal says
      // plainly that there is nothing here to call an MCP tool through,
      // rather than a bare "unknown" that leaves the model guessing.
      const mcpQualifiedNoRoute = await fixture.tool.execute({ mode: 'tool', toolName: 'mcp:playwright:browser_tabs' });
      expect(mcpQualifiedNoRoute.success).toBe(false);
      expect(mcpQualifiedNoRoute.error).toContain('mcp:playwright:browser_tabs');
      expect(mcpQualifiedNoRoute.error).toContain('no "mcp" tool is registered');

      // With an "mcp" tool registered (the real shape of the incident): the
      // model saw `mcp:playwright:browser_tabs` listed by `mcp mode:"tools"`,
      // then asked this catalog to describe it as if it were a directly
      // callable tool. A bare "unknown" sent the model looking for a route
      // that does not exist; the fix names the real one.
      fixture.toolRegistry.register({
        definition: {
          name: 'mcp',
          description: 'Inspect and call MCP servers.',
          parameters: { type: 'object', properties: { mode: { type: 'string' } }, required: ['mode'], additionalProperties: false },
        },
        execute: async () => ({ success: true, output: '{}' }),
      });
      const mcpQualified = await fixture.tool.execute({ mode: 'tool', toolName: 'mcp:playwright:browser_tabs' });
      expect(mcpQualified.success).toBe(false);
      expect(mcpQualified.error).toContain('mcp:playwright:browser_tabs');
      expect(mcpQualified.error).toContain('not a directly callable tool');
      expect(mcpQualified.error).toContain('mcp mode:"call" qualifiedName:"mcp:playwright:browser_tabs"');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes release evidence artifacts and readiness inventory lookup to the model', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      if (!summary.success) throw new Error(summary.error);
      const summaryJson = JSON.parse(summary.output!) as {
        readonly releaseEvidence?: { readonly status?: string; readonly artifacts?: number; readonly available?: number };
        readonly releaseReadiness?: { readonly status?: string; readonly path?: string; readonly items?: number };
        readonly modelAccess?: { readonly releaseEvidence?: string; readonly releaseReadiness?: string };
      };
      expect(summaryJson.releaseEvidence?.status).toBe('available');
      expect(summaryJson.releaseEvidence?.artifacts).toBe(5);
      expect(summaryJson.releaseEvidence?.available).toBe(5);
      expect(summaryJson.releaseReadiness?.status).toBe('available');
      expect(summaryJson.releaseReadiness?.path).toBe('release/release-readiness.json');
      expect(summaryJson.releaseReadiness?.items).toBeGreaterThan(0);
      expect(summaryJson.modelAccess?.releaseEvidence).toContain('audit action:"evidence|artifact"');
      expect(summaryJson.modelAccess?.releaseReadiness).toContain('audit action:"readiness|item"');

      const evidence = await fixture.tool.execute({
        mode: 'release_evidence',
        query: 'live verification',
      });
      expect(evidence.success).toBe(true);
      if (!evidence.success) throw new Error(evidence.error);
      const evidenceJson = JSON.parse(evidence.output!) as {
        readonly mode: string;
        readonly artifacts: number;
        readonly available: number;
        readonly filtered: number;
        readonly artifactsList: readonly { readonly id?: string; readonly path?: string; readonly summary?: Record<string, unknown>; readonly content?: string }[];
      };
      expect(evidenceJson.mode).toBe('release_evidence');
      expect(evidenceJson.artifacts).toBe(5);
      expect(evidenceJson.available).toBe(5);
      expect(evidenceJson.filtered).toBe(2);
      expect(evidenceJson.artifactsList.map((artifact) => artifact.id)).toEqual([
        'live-verification-json',
        'live-verification-markdown',
      ]);
      expect(evidenceJson.artifactsList.map((artifact) => artifact.content)).toEqual([undefined, undefined]);

      const notesArtifact = await fixture.tool.execute({
        mode: 'release_evidence_artifact',
        artifactId: 'release-notes',
      });
      expect(notesArtifact.success).toBe(true);
      if (!notesArtifact.success) throw new Error(notesArtifact.error);
      const notesArtifactJson = JSON.parse(notesArtifact.output!) as {
        readonly status: string;
        readonly lookup: { readonly source: string; readonly input?: string; readonly resolvedBy: string };
        readonly artifact: { readonly id: string; readonly path: string; readonly content?: string; readonly summary?: { readonly bullets?: number } };
      };
      expect(notesArtifactJson.status).toBe('found');
      expect(notesArtifactJson.lookup.source).toBe('artifactId');
      expect(notesArtifactJson.lookup.resolvedBy).toBe('id');
      expect(notesArtifactJson.artifact.id).toBe('release-notes');
      expect(notesArtifactJson.artifact.path).toBe('release/release-notes.md');
      // Assert the SHAPE of the notes, never their wording: the live
      // release/release-notes.md is rewritten every release, so pinning a
      // phrase from one release's copy makes this test fail on the next one.
      expect(notesArtifactJson.artifact.content).toBeTruthy();
      expect(notesArtifactJson.artifact.content!.trimStart().startsWith('- ')).toBe(true);
      expect(notesArtifactJson.artifact.summary?.bullets).toBeGreaterThan(0);

      const ambiguousArtifact = await fixture.tool.execute({ mode: 'release_evidence_artifact', query: 'live verification' });
      expect(ambiguousArtifact.success).toBe(false);
      expect(ambiguousArtifact.error).toContain('Ambiguous release evidence artifact live verification');

      const missingArtifact = await fixture.tool.execute({ mode: 'release_evidence_artifact', artifactId: 'not-release-evidence' });
      expect(missingArtifact.success).toBe(false);
      expect(missingArtifact.error).toContain('Unknown release evidence artifact not-release-evidence');

      const inventory = await fixture.tool.execute({
        mode: 'release_readiness',
        query: 'release-quality inventory',
        limit: 5,
      });
      expect(inventory.success).toBe(true);
      if (!inventory.success) throw new Error(inventory.error);
      const inventoryJson = JSON.parse(inventory.output!) as {
        readonly mode: string;
        readonly path: string;
        readonly totals: {
          readonly items: number;
          readonly filtered: number;
          readonly requiredQualityDimensions: readonly string[];
          readonly completeQualityDimensions: number;
          readonly expectedQualityDimensions: number;
        };
        readonly items: readonly { readonly id?: string; readonly quality?: unknown }[];
      };
      expect(inventoryJson.mode).toBe('release_readiness');
      expect(inventoryJson.path).toBe('release/release-readiness.json');
      expect(inventoryJson.totals.items).toBeGreaterThan(0);
      expect(inventoryJson.totals.filtered).toBeGreaterThan(0);
      expect(inventoryJson.totals.requiredQualityDimensions).toContain('modelAccess');
      expect(inventoryJson.totals.completeQualityDimensions).toBe(inventoryJson.totals.expectedQualityDimensions);
      expect(inventoryJson.items.map((item) => item.id)).toContain('release-readiness-inventory-gate');
      expect(inventoryJson.items.map((item) => item.quality)).toEqual(Array(inventoryJson.items.length).fill(undefined));

      const inventoryWithQuality = await fixture.tool.execute({
        mode: 'release_readiness',
        query: 'release-quality inventory',
        includeParameters: true,
        limit: 1,
      });
      expect(inventoryWithQuality.success).toBe(true);
      expect(inventoryWithQuality.output).toContain('"quality"');

      const item = await fixture.tool.execute({
        mode: 'release_readiness_item',
        itemId: 'release-readiness-inventory-gate',
      });
      expect(item.success).toBe(true);
      if (!item.success) throw new Error(item.error);
      const itemJson = JSON.parse(item.output!) as {
        readonly status: string;
        readonly lookup: { readonly source: string; readonly resolvedBy: string };
        readonly item: { readonly id: string; readonly quality: { readonly modelAccess?: string } };
      };
      expect(itemJson.status).toBe('found');
      expect(itemJson.lookup.source).toBe('itemId');
      expect(itemJson.lookup.resolvedBy).toBe('id');
      expect(itemJson.item.id).toBe('release-readiness-inventory-gate');
      expect(itemJson.item.quality.modelAccess).toContain('release_evidence');
      expect(itemJson.item.quality.modelAccess).toContain('release_readiness');

      const ambiguous = await fixture.tool.execute({ mode: 'release_readiness_item', query: 'Agent' });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous release readiness item Agent');

      const missing = await fixture.tool.execute({ mode: 'release_readiness_item', itemId: 'not-a-readiness-item' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown release readiness item not-a-readiness-item');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes operator method catalog and service posture as read-only model surfaces', async () => {
    const fixture = makeFixture();
    try {
      fixture.configManager.setDynamic('controlPlane.enabled', false);
      fixture.configManager.setDynamic('danger.httpListener', false);
      fixture.configManager.setDynamic('web.enabled', false);

      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      if (!summary.success) throw new Error(summary.error);
      const summaryJson = JSON.parse(summary.output!) as {
        readonly operatorMethods?: { readonly modes?: readonly string[]; readonly methods?: number; readonly readOnlyMethods?: number };
        readonly servicePosture?: { readonly modes?: readonly string[]; readonly endpointIds?: readonly string[]; readonly readOnly?: boolean };
        readonly modelAccess?: { readonly operatorMethods?: string; readonly servicePosture?: string };
      };
      expect(summaryJson.operatorMethods?.modes).toEqual(['operator_methods', 'operator_method']);
      expect(summaryJson.operatorMethods?.methods).toBeGreaterThan(10);
      expect(summaryJson.operatorMethods?.readOnlyMethods).toBeGreaterThan(5);
      expect(summaryJson.servicePosture?.modes).toEqual(['service_posture', 'service_endpoint']);
      expect(summaryJson.servicePosture?.endpointIds).toEqual(['controlPlane', 'httpListener', 'web']);
      expect(summaryJson.servicePosture?.readOnly).toBe(true);
      expect(summaryJson.modelAccess?.operatorMethods).toContain('host action:"methods|method"');
      expect(summaryJson.modelAccess?.servicePosture).toContain('host action:"services|service"');

      const catalog = await fixture.tool.execute({
        mode: 'operator_methods',
        query: 'knowledge',
        includeParameters: true,
        limit: 120,
      });
      expect(catalog.success).toBe(true);
      if (!catalog.success) throw new Error(catalog.error);
      const catalogJson = JSON.parse(catalog.output!) as {
        readonly methods: readonly { readonly id: string; readonly route: string; readonly preferredModelTool: string; readonly parameters?: readonly unknown[] }[];
      };
      expect(catalogJson.methods.map((method) => method.id)).toContain('knowledge.map');
      expect(catalogJson.methods.map((method) => method.route)).toContain('GET /api/knowledge/connectors/{id}/doctor');
      expect(catalogJson.methods.find((method) => method.id === 'knowledge.ingest.url')?.parameters?.length).toBeGreaterThan(0);

      const schedule = await fixture.tool.execute({ mode: 'operator_method', methodId: 'automation.schedules.create' });
      expect(schedule.success).toBe(true);
      if (!schedule.success) throw new Error(schedule.error);
      const scheduleJson = JSON.parse(schedule.output!) as {
        readonly id: string;
        readonly preferredModelTool: string;
        readonly parameters: readonly { readonly name: string; readonly required: boolean }[];
      };
      expect(scheduleJson.id).toBe('automation.schedules.create');
      expect(scheduleJson.preferredModelTool).toContain('agent_operator_method');
      expect(scheduleJson.parameters.map((parameter) => parameter.name)).toEqual(expect.arrayContaining([
        'prompt',
        'kind',
        'every',
        'delivery',
      ]));

      const posture = await fixture.tool.execute({ mode: 'service_posture', includeParameters: true });
      expect(posture.success).toBe(true);
      if (!posture.success) throw new Error(posture.error);
      const postureJson = JSON.parse(posture.output!) as {
        readonly readOnly: boolean;
        readonly endpoints: readonly { readonly id: string; readonly policy: { readonly lifecycle: string } }[];
      };
      expect(postureJson.readOnly).toBe(true);
      expect(postureJson.endpoints.map((endpoint) => endpoint.id)).toEqual(['controlPlane', 'httpListener', 'web']);
      expect(postureJson.endpoints[0]?.policy.lifecycle).toContain('confirmed GoodVibes daemon operator methods');

      const endpoint = await fixture.tool.execute({ mode: 'service_endpoint', query: 'browser companion route' });
      expect(endpoint.success).toBe(true);
      if (!endpoint.success) throw new Error(endpoint.error);
      const endpointJson = JSON.parse(endpoint.output!) as {
        readonly id: string;
        readonly lookup: { readonly source: string; readonly input?: string; readonly resolvedBy: string };
        readonly policy: { readonly effect: string; readonly lifecycle: string };
      };
      expect(endpointJson.id).toBe('web');
      expect(endpointJson.lookup).toEqual({
        source: 'query',
        input: 'browser companion route',
        resolvedBy: 'label',
      });
      expect(endpointJson.policy.effect).toBe('read-only');
      expect(endpointJson.policy.lifecycle).toContain('confirmed GoodVibes daemon operator methods');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes top-level CLI mirror metadata without enabling hidden CLI execution', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      expect(summary.output).toContain('"cliCommands"');
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly cliCommands?: string } };
      expect(summaryJson.modelAccess?.cliCommands).toContain('workspace action:"cli_commands');

      const catalog = await fixture.tool.execute({ mode: 'cli_commands', query: 'knowledge' });
      expect(catalog.success).toBe(true);
      expect(catalog.output).toContain('"name": "knowledge"');
      expect(catalog.output).toContain('"blockedTokens"');
      expect(catalog.output).toContain('"daemon"');
      expect(catalog.output).toContain('CLI modes are read-only discovery');
      const compactCliJson = JSON.parse(catalog.output!) as {
        readonly commands: readonly { readonly name: string; readonly effect?: string; readonly modelRoute?: string }[];
      };
      expect(compactCliJson.commands.filter((command) => (
        command.name === 'knowledge'
        && command.effect === 'mixed'
        && command.modelRoute === 'agent_knowledge or agent_knowledge_ingest'
      ))).toHaveLength(1);
      expect(compactCliJson.commands.filter((command) => (command.modelRoute?.length ?? 0) > 72)).toEqual([]);

      const detailedCatalog = await fixture.tool.execute({ mode: 'cli_commands', query: 'knowledge', includeParameters: true });
      expect(detailedCatalog.success).toBe(true);
      expect(detailedCatalog.output).toContain('agent_knowledge or agent_knowledge_ingest');

      const parsed = await fixture.tool.execute({
        mode: 'cli_command',
        cliCommand: 'goodvibes-agent status --json --config surfaces.slack.botToken=xoxb-secret-value',
      });
      expect(parsed.success).toBe(true);
      expect(parsed.output).toContain('"name": "status"');
      expect(parsed.output).toContain('"resolvedBy": "invocation"');
      expect(parsed.output).toContain('"outputFormat": "json"');
      expect(parsed.output).toContain('surfaces.slack.botToken=<redacted>');
      expect(parsed.output).not.toContain('xoxb-secret-value');

      const lookedUp = await fixture.tool.execute({
        mode: 'cli_command',
        query: 'Call isolated Agent Knowledge routes',
      });
      expect(lookedUp.success).toBe(true);
      expect(lookedUp.output).toContain('"name": "knowledge"');
      expect(lookedUp.output).toContain('"resolvedBy": "search"');
      expect(lookedUp.output).toContain('agent_knowledge or agent_knowledge_ingest');

      const ambiguous = await fixture.tool.execute({
        mode: 'cli_command',
        query: 'Agent',
      });
      expect(ambiguous.success).toBe(true);
      expect(ambiguous.output).toContain('"status": "ambiguous"');
      expect(ambiguous.output).toContain('"candidates"');
      expect(ambiguous.output).toContain('goodvibes-agent');

      const blocked = await fixture.tool.execute({ mode: 'cli_command', cliCommand: 'daemon start' });
      expect(blocked.success).toBe(true);
      expect(blocked.output).toContain('"supported": false');
      expect(blocked.output).toContain('Unsupported command: daemon');
      expect(blocked.output).toContain('connected-host');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes modal and picker UI surfaces with confirmation-gated visible routing', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      expect(summary.output).toContain('"uiSurfaces"');
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly uiSurfaces?: string } };
      expect(summaryJson.modelAccess?.uiSurfaces).toContain('workspace action:"surfaces');

      const catalog = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'picker' });
      expect(catalog.success).toBe(true);
      expect(catalog.output).toContain('"id": "model-picker"');
      expect(catalog.output).toContain('"id": "provider-picker"');
      expect(catalog.output).toContain('"id": "reasoning-effort-picker"');
      expect(catalog.output).toContain('"id": "tts-provider-picker"');
      expect(catalog.output).toContain('"id": "tts-voice-picker"');
      expect(catalog.output).toContain('"id": "file-picker"');
      expect(catalog.output).toContain('modelRoute');
      expect(catalog.output).not.toContain('preferredModelRoute');
      expectCompactSummaryFields(JSON.parse(catalog.output!));
      expectModelFacingText(catalog.output!);
      const catalogJson = JSON.parse(catalog.output!) as {
        readonly surfaces: readonly { readonly id?: string; readonly modelRoute?: string }[];
      };
      expect(catalogJson.surfaces.filter((surface) => (
        typeof surface.modelRoute !== 'string'
        || surface.modelRoute.length === 0
        || surface.modelRoute.length > 72
      ))).toEqual([]);
      expect(catalogJson.surfaces.find((surface) => surface.id === 'model-picker')?.modelRoute).toBe('settings action:"get|set" or workspace action:"run_command"');

      const searchSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'search' });
      expect(searchSurfaces.success).toBe(true);
      expect(searchSurfaces.output).toContain('"id": "conversation-search"');
      expect(searchSurfaces.output).toContain('"id": "prompt-history-search"');

      const commandSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'slash-command' });
      expect(commandSurfaces.success).toBe(true);
      expect(commandSurfaces.output).toContain('"id": "slash-command-mode"');

      const commandBrowserSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'command browser' });
      expect(commandBrowserSurfaces.success).toBe(true);
      expect(commandBrowserSurfaces.output).toContain('"id": "command-browser"');

      const blockSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'block action' });
      expect(blockSurfaces.success).toBe(true);
      expect(blockSurfaces.output).toContain('"id": "block-actions"');

      const operatorSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'operator' });
      expect(operatorSurfaces.success).toBe(true);
      expect(operatorSurfaces.output).toContain('"id": "panel-picker"');
      expect(operatorSurfaces.output).toContain('"id": "security-panel"');
      expect(operatorSurfaces.output).toContain('"id": "knowledge-panel"');
      expect(operatorSurfaces.output).toContain('"id": "subscription-panel"');

      const browserSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'browser cockpit pwa' });
      expect(browserSurfaces.success).toBe(true);
      expect(browserSurfaces.output).toContain('"id": "connected-browser-cockpit"');
      // web.enabled now defaults true (dissolved feature model, default-on
      // with announce-once receipts), so a stock config reports the cockpit
      // route as available/ready instead of unavailable.
      expect(browserSurfaces.output).toContain('"available": true');
      expect(browserSurfaces.output).toContain('"readiness": "ready"');

      const activitySurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'activity' });
      expect(activitySurfaces.success).toBe(true);
      expect(activitySurfaces.output).toContain('"id": "process-monitor"');
      expect(activitySurfaces.output).toContain('Visible running-process and live-output monitor.');
      expect(activitySurfaces.output).toContain('first-class tools or workspace action:\\"open\\"');

      const outputSurfaces = await fixture.tool.execute({ mode: 'ui_surfaces', query: 'live-output' });
      expect(outputSurfaces.success).toBe(true);
      expect(outputSurfaces.output).toContain('"id": "live-tail"');

      const settings = await fixture.tool.execute({ mode: 'ui_surface', surfaceId: 'settings' });
      expect(settings.success).toBe(true);
      const settingsJson = JSON.parse(settings.output ?? '{}') as {
        readonly id?: string;
        readonly modelRoute?: string;
        readonly preferredModelRoute?: string;
      };
      expect(settingsJson.id).toBe('settings');
      expect(settingsJson.modelRoute).toBe('settings action:"list|get|set" or workspace action:"open"');
      expect(settingsJson.preferredModelRoute).toContain('settings action:"list"|action:"get"|action:"set"|action:"reset"|action:"import"');
      expect(settingsJson.preferredModelRoute).not.toContain('settings/get_setting/set_setting/reset_setting');
      expectModelFacingText(settings.output!);

      // web.enabled defaults true now (dissolved feature model, default-on);
      // disable it explicitly so this phase still exercises the honest
      // setup-needed reporting before the enabled phase below.
      fixture.configManager.setDynamic('web.enabled', false);
      const browserCockpit = await fixture.tool.execute({ mode: 'ui_surface', surfaceId: 'connected-browser-cockpit' });
      expect(browserCockpit.success).toBe(true);
      const browserCockpitJson = JSON.parse(browserCockpit.output ?? '{}') as {
        readonly id?: string;
        readonly available?: boolean;
        readonly cockpit?: {
          readonly enabled?: boolean;
          readonly readiness?: string;
          readonly url?: string;
          readonly source?: string;
          readonly setupRoutes?: Record<string, string>;
          readonly workspaceCoverage?: {
            readonly status?: string;
            readonly categoryCount?: number;
            readonly nativeCategoryRoutesPublished?: boolean;
            readonly lanes?: readonly { readonly id?: string; readonly browserStatus?: string; readonly agentRoutes?: readonly string[] }[];
            readonly categories?: readonly { readonly id?: string; readonly browserStatus?: string; readonly agentRoute?: string }[];
          };
          readonly mobile?: { readonly status?: string; readonly controls?: readonly { readonly id?: string; readonly status?: string }[] };
          readonly receipts?: {
            readonly status?: string;
            readonly agentOnboardingCompletion?: { readonly status?: string; readonly exists?: boolean };
            readonly browserFirstRunCompletion?: { readonly status?: string; readonly webEnabled?: boolean };
          };
        };
      };
      expect(browserCockpitJson.id).toBe('connected-browser-cockpit');
      expect(browserCockpitJson.available).toBe(false);
      expect(browserCockpitJson.cockpit?.enabled).toBe(false);
      expect(browserCockpitJson.cockpit?.readiness).toBe('setup-needed');
      expect(browserCockpitJson.cockpit?.url).toBe('http://127.0.0.1:3423');
      expect(browserCockpitJson.cockpit?.setupRoutes?.inspectEndpoint).toContain('endpointId:"web"');
      expect(browserCockpitJson.cockpit?.workspaceCoverage).toMatchObject({
        status: 'web-setup-needed',
        nativeCategoryRoutesPublished: false,
      });
      expect(browserCockpitJson.cockpit?.workspaceCoverage?.categoryCount).toBeGreaterThan(20);
      expect(browserCockpitJson.cockpit?.workspaceCoverage?.lanes?.some((lane) => lane.id === 'setup-and-settings' && lane.browserStatus === 'blocked-by-web-setup')).toBe(true);
      expect(browserCockpitJson.cockpit?.workspaceCoverage?.categories?.some((category) => category.id === 'home' && category.browserStatus === 'blocked-by-web-setup' && category.agentRoute?.includes('categoryId:"home"'))).toBe(true);
      expect(browserCockpitJson.cockpit?.mobile?.status).toBe('setup-needed');
      expect(browserCockpitJson.cockpit?.mobile?.controls?.some((control) => control.id === 'inspect-web-endpoint' && control.status === 'ready')).toBe(true);
      expect(browserCockpitJson.cockpit?.receipts).toMatchObject({
        status: 'needs-agent-closeout-and-browser-receipt',
        agentOnboardingCompletion: { status: 'missing', exists: false },
        browserFirstRunCompletion: { status: 'not-published', webEnabled: false },
      });

      fixture.configManager.setDynamic('web.enabled', true);
      fixture.configManager.setDynamic('web.publicBaseUrl', 'https://agent.example.test');
      const enabledBrowserCockpit = await fixture.tool.execute({ mode: 'ui_surface', surfaceId: 'connected-browser-cockpit' });
      expect(enabledBrowserCockpit.success).toBe(true);
      const enabledBrowserCockpitJson = JSON.parse(enabledBrowserCockpit.output ?? '{}') as typeof browserCockpitJson;
      expect(enabledBrowserCockpitJson.available).toBe(true);
      expect(enabledBrowserCockpitJson.cockpit?.readiness).toBe('ready');
      expect(enabledBrowserCockpitJson.cockpit?.url).toBe('https://agent.example.test');
      expect(enabledBrowserCockpitJson.cockpit?.source).toBe('web.publicBaseUrl');
      expect(enabledBrowserCockpitJson.cockpit?.workspaceCoverage).toMatchObject({
        status: 'needs-browser-native-category-contracts',
        nativeCategoryRoutesPublished: false,
      });
      expect(enabledBrowserCockpitJson.cockpit?.workspaceCoverage?.lanes?.some((lane) => lane.id === 'work-and-automation' && lane.browserStatus === 'needs-browser-native-contract')).toBe(true);
      expect(enabledBrowserCockpitJson.cockpit?.workspaceCoverage?.categories?.some((category) => category.id === 'work' && category.browserStatus === 'terminal-first')).toBe(true);
      expect(enabledBrowserCockpitJson.cockpit?.mobile?.status).toBe('openable');
      expect(enabledBrowserCockpitJson.cockpit?.receipts?.browserFirstRunCompletion).toMatchObject({
        status: 'not-published',
        webEnabled: true,
      });
      fixture.configManager.setDynamic('web.enabled', false);
      fixture.configManager.setDynamic('web.publicBaseUrl', '');

      const settingsByQuery = await fixture.tool.execute({
        mode: 'ui_surface',
        query: 'fullscreen settings workspace',
      });
      expect(settingsByQuery.success).toBe(true);
      const settingsByQueryJson = JSON.parse(settingsByQuery.output!);
      expect(settingsByQueryJson.id).toBe('settings');
      expect(settingsByQueryJson.lookup).toEqual({
        source: 'query',
        input: 'fullscreen settings workspace',
        resolvedBy: 'search',
      });

      const denied = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'settings',
        target: 'provider.model',
        explicitUserRequest: 'Open settings for the model setting.',
      });
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('confirm:true');
      expect(fixture.openedSurfaces).toEqual([]);

      const openedSettings = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'settings',
        target: 'provider.model',
        confirm: true,
        explicitUserRequest: 'Open settings for the model setting.',
      });
      expect(openedSettings.success).toBe(true);
      expect(openedSettings.output).toContain('"status": "opened"');
      expectModelFacingText(openedSettings.output!);
      expect(fixture.openedSurfaces).toEqual([{ id: 'settings', detail: 'provider.model' }]);

      const ambiguousSurface = await fixture.tool.execute({
        mode: 'open_ui_surface',
        query: 'picker',
        confirm: true,
        explicitUserRequest: 'Open a picker.',
      });
      expect(ambiguousSurface.success).toBe(true);
      expect(ambiguousSurface.output).toContain('"status": "ambiguous_ui_surface"');
      expect(ambiguousSurface.output).toContain('model-picker');
      expect(fixture.openedSurfaces).toEqual([{ id: 'settings', detail: 'provider.model' }]);

      const openedWorkspace = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'agent-workspace',
        categoryId: 'knowledge',
        confirm: true,
        explicitUserRequest: 'Open the Knowledge workspace.',
      });
      expect(openedWorkspace.success).toBe(true);
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'knowledge' });

      const disabledBrowserCockpit = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'connected-browser-cockpit',
        confirm: true,
        explicitUserRequest: 'Open the connected browser cockpit.',
      });
      expect(disabledBrowserCockpit.success).toBe(true);
      expect(disabledBrowserCockpit.output).toContain('"status": "setup_needed"');
      const disabledBrowserCockpitJson = JSON.parse(disabledBrowserCockpit.output!) as {
        readonly route?: { readonly setupRoutes?: { readonly inspectEndpoint?: string } };
        readonly descriptor?: { readonly modelRoute?: string };
      };
      expect(disabledBrowserCockpitJson.route?.setupRoutes?.inspectEndpoint).toContain('host action:"service"');
      expect(disabledBrowserCockpitJson.descriptor?.modelRoute).toContain('computer action:"browser|open_browser"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'knowledge' });

      const openedPanelPicker = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'panel-picker',
        confirm: true,
        explicitUserRequest: 'Open the operator panel picker.',
      });
      expect(openedPanelPicker.success).toBe(true);
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'panel-picker', detail: 'home' });

      const openedSecurity = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'security-panel',
        confirm: true,
        explicitUserRequest: 'Open the security operator surface.',
      });
      expect(openedSecurity.success).toBe(true);
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'tools' });

      const openedKnowledge = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'knowledge-panel',
        confirm: true,
        explicitUserRequest: 'Open the knowledge operator surface.',
      });
      expect(openedKnowledge.success).toBe(true);
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'knowledge' });

      const openedSubscription = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'subscription-panel',
        confirm: true,
        explicitUserRequest: 'Open the subscription operator surface.',
      });
      expect(openedSubscription.success).toBe(true);
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'agent-workspace', detail: 'setup' });

      const openedProcessMonitor = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'process-monitor',
        confirm: true,
        explicitUserRequest: 'Open the runtime activity monitor.',
      });
      expect(openedProcessMonitor.success).toBe(true);
      expect(openedProcessMonitor.output).toContain('"status": "opened"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'process-monitor' });

      const openedLiveTail = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'live-tail',
        target: 'sleep',
        confirm: true,
        explicitUserRequest: 'Open live output for the running sleep process.',
      });
      expect(openedLiveTail.success).toBe(true);
      expect(openedLiveTail.output).toContain('"processId": "bg-test"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'live-tail', detail: 'sleep' });

      const openedConversationSearch = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'conversation-search',
        query: 'approval',
        confirm: true,
        explicitUserRequest: 'Open transcript search for approval.',
      });
      expect(openedConversationSearch.success).toBe(true);
      expect(openedConversationSearch.output).toContain('"query": "approval"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'conversation-search', detail: 'approval' });

      const openedPromptHistorySearch = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'prompt-history-search',
        query: 'deploy',
        confirm: true,
        explicitUserRequest: 'Open prompt history search for deploy.',
      });
      expect(openedPromptHistorySearch.success).toBe(true);
      expect(openedPromptHistorySearch.output).toContain('"query": "deploy"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'prompt-history-search', detail: 'deploy' });

      const openedSlashCommandMode = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'slash-command-mode',
        query: 'help',
        confirm: true,
        explicitUserRequest: 'Open slash command mode for help.',
      });
      expect(openedSlashCommandMode.success).toBe(true);
      expect(openedSlashCommandMode.output).toContain('"query": "help"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'slash-command-mode', detail: 'help' });

      const openedCommandBrowser = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'command-browser',
        confirm: true,
        explicitUserRequest: 'Open the command browser.',
      });
      expect(openedCommandBrowser.success).toBe(true);
      expect(openedCommandBrowser.output).toContain('"command": "/commands"');
      expect(fixture.openedSelections.at(-1)).toEqual({
        title: 'Help - Commands',
        itemIds: ['/brief'],
        preSelectId: undefined,
      });

      const openedFilePicker = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'file-picker',
        target: 'inject',
        query: 'src',
        confirm: true,
        explicitUserRequest: 'Open the file picker for raw source injection.',
      });
      expect(openedFilePicker.success).toBe(true);
      expect(openedFilePicker.output).toContain('"mode": "inject"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'file-picker', detail: 'inject:src' });

      const openedReasoningEffort = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'reasoning-effort-picker',
        confirm: true,
        explicitUserRequest: 'Open the reasoning effort picker.',
      });
      expect(openedReasoningEffort.success).toBe(true);
      expect(openedReasoningEffort.output).toContain('"model": "Reasoning Model"');
      expect(fixture.openedSelections.at(-1)).toEqual({
        title: 'Reasoning Effort',
        itemIds: ['low', 'medium', 'high'],
        preSelectId: 'medium',
      });

      const openedBlockActions = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'block-actions',
        confirm: true,
        explicitUserRequest: 'Open block actions for the nearest transcript block.',
      });
      expect(openedBlockActions.success).toBe(true);
      expect(openedBlockActions.output).toContain('"surface": "block-actions"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'block-actions' });

      fixture.configManager.setDynamic('tts.provider', 'stream-voice');
      fixture.configManager.setDynamic('tts.voice', '');
      const openedTtsProvider = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'tts-provider-picker',
        confirm: true,
        explicitUserRequest: 'Open the TTS provider picker.',
      });
      expect(openedTtsProvider.success).toBe(true);
      expect(openedTtsProvider.output).toContain('"status": "opened"');
      expect(fixture.openedSelections.at(-1)).toEqual({
        title: 'Choose TTS Provider',
        itemIds: ['stream-voice'],
        preSelectId: 'stream-voice',
      });

      const openedTtsProviderByQuery = await fixture.tool.execute({
        mode: 'open_ui_surface',
        query: 'streaming TTS provider picker',
        confirm: true,
        explicitUserRequest: 'Open the TTS provider picker.',
      });
      expect(openedTtsProviderByQuery.success).toBe(true);
      expect(openedTtsProviderByQuery.output).toContain('"status": "opened"');
      expect(openedTtsProviderByQuery.output).toContain('"source": "query"');

      const openedTtsVoice = await fixture.tool.execute({
        mode: 'open_ui_surface',
        surfaceId: 'tts-voice-picker',
        target: 'stream-voice',
        confirm: true,
        explicitUserRequest: 'Open the TTS voice picker for stream-voice.',
      });
      expect(openedTtsVoice.success).toBe(true);
      expect(openedTtsVoice.output).toContain('"providerId": "stream-voice"');
      expect(fixture.openedSelections.at(-1)).toEqual({
        title: 'Choose TTS Voice (stream-voice)',
        itemIds: ['__default__', 'stream-voice-voice-a', 'stream-voice-voice-b'],
        preSelectId: '__default__',
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('consumes certified browser PWA category routes and first-run receipts', async () => {
    const fixture = makeFixture();
    try {
      fixture.configManager.setDynamic('web.enabled', true);
      fixture.configManager.setDynamic('web.publicBaseUrl', 'https://agent.example.test/app');
      const categoryIds = AGENT_WORKSPACE_CATEGORIES.map((category) => category.id);
      const platform = fixture.context.platform as unknown as { readModels: Record<string, unknown> };
      platform.readModels.browserPwa = {
        categoryRoutes: {
          getSnapshot: () => ({
            records: [{
              id: 'browser-pwa-all-categories',
              routeId: 'browser-pwa-all-categories',
              categoryIds,
              laneId: 'agent-workspace',
              label: 'Browser-native Agent workspace',
              status: 'ready',
              summary: 'Responsive cockpit controls are ready token=browser-summary-secret',
              mobileReady: true,
              pwaReady: true,
              capabilities: ['chat', 'setup', 'approvals', 'automations', 'memory', 'channels', 'research', 'safety', 'mobile touch', 'PWA install'],
              routes: {
                inspect: 'computer action:"browser" includeParameters:true',
                open: 'https://agent.example.test/app/workspaces?token=browser-route-secret',
                chat: 'https://agent.example.test/app/chat?token=browser-chat-secret',
                setup: 'https://agent.example.test/app/setup?token=browser-setup-secret',
                approvals: 'https://agent.example.test/app/approvals?token=browser-approval-secret',
                automations: 'https://agent.example.test/app/automation?token=browser-automation-secret',
                memory: 'https://agent.example.test/app/memory?token=browser-memory-secret',
                channels: 'https://agent.example.test/app/channels?token=browser-channel-secret',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.browserPwa.categoryRoute.v1',
              publicationGuarantee: 'daemon publishes browser route receipts secret=browser-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method browserPwa.categoryRoutes.list', 'sourceTool connected-host-web'],
              cursor: 'browser-category-cursor-1',
              receiptId: 'browser-category-route-receipt-1',
            }],
          }),
        },
        firstRunReceipts: {
          getSnapshot: () => ({
            records: [{
              id: 'browser-first-run-live-1',
              receiptId: 'browser-first-run-live-1',
              setupStepId: 'browser-pwa',
              methodId: 'browser.pwa.firstRun',
              status: 'published',
              receiptStatus: 'published',
              recordedAt: '1970-01-01T00:00:06.000Z',
              summary: 'Browser/PWA first-run completed token=browser-first-run-secret',
              url: 'https://agent.example.test/app?token=browser-url-secret',
              manifestStatus: 'ready',
              serviceWorkerStatus: 'active',
              installStatus: 'installed',
              offlineStatus: 'ready',
              capabilities: ['manifest', 'service worker', 'offline cache', 'install prompt'],
              routes: {
                inspect: 'computer action:"browser" includeParameters:true',
                open: 'https://agent.example.test/app?token=browser-open-secret',
                install: 'https://agent.example.test/app/install?token=browser-install-secret',
              },
              schemaStatus: 'certified',
              schemaVersion: 'goodvibes.browserPwa.firstRun.v1',
              publicationGuarantee: 'browser runtime publishes first-run receipts secret=browser-first-run-publication-secret',
              publisher: 'goodvibes-daemon',
              provenance: ['method browser.pwa.firstRun', 'sourceTool connected-host-web'],
              cursor: 'browser-first-run-cursor-1',
            }],
          }),
        },
      };

      const browserCockpit = await executeHarnessJson<{
        readonly id?: string;
        readonly available?: boolean;
        readonly cockpit?: {
          readonly readiness?: string;
          readonly workspaceCoverage?: {
            readonly status?: string;
            readonly categoryCount?: number;
            readonly coveredCategoryCount?: number;
            readonly nativeCategoryRoutesPublished?: boolean;
            readonly lanes?: readonly { readonly id?: string; readonly browserStatus?: string; readonly coveredCategoryCount?: number }[];
            readonly categories?: readonly { readonly id?: string; readonly browserStatus?: string; readonly browserRoute?: string | null; readonly mobileReady?: boolean }[];
            readonly publishedCategoryRoutes?: readonly { readonly certification?: { readonly missingSignals?: readonly string[]; readonly receiptId?: string } }[];
          };
          readonly mobile?: {
            readonly status?: string;
            readonly pwaInstall?: { readonly status?: string };
            readonly touchControls?: { readonly status?: string };
            readonly nativeControls?: readonly { readonly id?: string; readonly status?: string }[];
          };
          readonly receipts?: {
            readonly status?: string;
            readonly browserFirstRunStatus?: string;
            readonly browserFirstRunCompletion?: {
              readonly status?: string;
              readonly certifiedReadModelCount?: number;
              readonly evidence?: {
                readonly certification?: { readonly missingSignals?: readonly string[]; readonly receiptId?: string };
                readonly summary?: string | null;
                readonly url?: string | null;
              } | null;
            };
          };
        };
      }>(fixture, { mode: 'ui_surface', surfaceId: 'connected-browser-cockpit' });

      expect(browserCockpit.id).toBe('connected-browser-cockpit');
      expect(browserCockpit.available).toBe(true);
      expect(browserCockpit.cockpit?.readiness).toBe('browser-native-ready');
      expect(browserCockpit.cockpit?.workspaceCoverage).toMatchObject({
        status: 'browser-native-ready',
        categoryCount: categoryIds.length,
        coveredCategoryCount: categoryIds.length,
        nativeCategoryRoutesPublished: true,
      });
      expect(browserCockpit.cockpit?.workspaceCoverage?.lanes?.every((lane) => lane.browserStatus === 'browser-native-ready')).toBe(true);
      expect(browserCockpit.cockpit?.workspaceCoverage?.categories?.every((category) => category.browserStatus === 'browser-native-ready' && category.browserRoute && category.mobileReady === true)).toBe(true);
      expect(browserCockpit.cockpit?.workspaceCoverage?.publishedCategoryRoutes?.[0]?.certification?.missingSignals).toEqual([]);
      expect(browserCockpit.cockpit?.workspaceCoverage?.publishedCategoryRoutes?.[0]?.certification?.receiptId).toBe('browser-category-route-receipt-1');
      expect(browserCockpit.cockpit?.mobile?.status).toBe('browser-native-ready');
      expect(browserCockpit.cockpit?.mobile?.pwaInstall?.status).toBe('certified-live-receipt');
      expect(browserCockpit.cockpit?.mobile?.touchControls?.status).toBe('ready');
      expect(browserCockpit.cockpit?.mobile?.nativeControls?.every((control) => control.status === 'ready')).toBe(true);
      expect(browserCockpit.cockpit?.receipts?.status).toBe('browser-ready-agent-onboarding-missing');
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunStatus).toBe('certified-live-receipt');
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.status).toBe('certified-live-receipt');
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.certifiedReadModelCount).toBe(1);
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.evidence?.certification?.missingSignals).toEqual([]);
      expect(browserCockpit.cockpit?.receipts?.browserFirstRunCompletion?.evidence?.certification?.receiptId).toBe('browser-first-run-live-1');
      const output = JSON.stringify(browserCockpit);
      expect(output).toContain('<redacted>');
      expect(output).not.toContain('browser-summary-secret');
      expect(output).not.toContain('browser-route-secret');
      expect(output).not.toContain('browser-chat-secret');
      expect(output).not.toContain('browser-setup-secret');
      expect(output).not.toContain('browser-approval-secret');
      expect(output).not.toContain('browser-automation-secret');
      expect(output).not.toContain('browser-memory-secret');
      expect(output).not.toContain('browser-channel-secret');
      expect(output).not.toContain('browser-publication-secret');
      expect(output).not.toContain('browser-first-run-secret');
      expect(output).not.toContain('browser-url-secret');
      expect(output).not.toContain('browser-open-secret');
      expect(output).not.toContain('browser-install-secret');
      expect(output).not.toContain('browser-first-run-publication-secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes shortcuts and confirmation-gated keybinding edits', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      expect(summary.output).toContain('"shortcuts"');
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly shortcuts?: string } };
      expect(summaryJson.modelAccess?.shortcuts).toContain('workspace action:"shortcuts');
      expect(summaryJson.modelAccess?.shortcuts).toContain('run_keybinding');

      const shortcuts = await fixture.tool.execute({ mode: 'shortcuts', query: 'help' });
      expect(shortcuts.success).toBe(true);
      expect(shortcuts.output).toContain('"fixedShortcuts"');
      expect(shortcuts.output).toContain('? / F1');
      expect(shortcuts.output).toContain('"configurableKeybindings"');

      const processShortcut = await fixture.tool.execute({ mode: 'shortcuts', query: 'runtime activity' });
      expect(processShortcut.success).toBe(true);
      expect(processShortcut.output).toContain('"key": "F2"');
      expect(processShortcut.output).toContain('Open runtime activity monitor');

      const shortcutsReference = await fixture.tool.execute({ mode: 'shortcuts', query: 'shortcut reference' });
      expect(shortcutsReference.success).toBe(true);
      expect(shortcutsReference.output).toContain('"key": "/shortcuts"');
      expect(shortcutsReference.output).toContain('Open keyboard shortcut reference');

      const keybinding = await fixture.tool.execute({ mode: 'keybinding', actionId: 'search' });
      expect(keybinding.success).toBe(true);
      expect(keybinding.output).toContain('"action": "search"');
      expect(keybinding.output).toContain('Ctrl+F');
      expect(keybinding.output).toContain('"customized": false');
      expect(keybinding.output).toContain('"modelOperation"');
      expect(keybinding.output).toContain('"preferredMode": "run_keybinding"');
      expect(keybinding.output).toContain('"surfaceId": "conversation-search"');

      const keybindingCatalog = await fixture.tool.execute({ mode: 'keybindings', limit: 500 });
      expect(keybindingCatalog.success).toBe(true);
      expectModelFacingText(shortcuts.output!);
      expectModelFacingText(keybindingCatalog.output!);
      expectModelFacingText(keybinding.output!);

      const keybindingByQuery = await fixture.tool.execute({ mode: 'keybinding', query: 'Ctrl+F' });
      expect(keybindingByQuery.success).toBe(true);
      const keybindingByQueryJson = JSON.parse(keybindingByQuery.output!);
      expect(keybindingByQueryJson.action).toBe('search');
      expect(keybindingByQueryJson.lookup).toEqual({
        source: 'query',
        input: 'Ctrl+F',
        resolvedBy: 'search',
      });

      const ambiguousKeybinding = await fixture.tool.execute({ mode: 'keybinding', query: 'workspace' });
      expect(ambiguousKeybinding.success).toBe(true);
      expect(ambiguousKeybinding.output).toContain('"status": "ambiguous"');
      expect(ambiguousKeybinding.output).toContain('workspace-picker');

      const runDenied = await fixture.tool.execute({
        mode: 'run_keybinding',
        actionId: 'search',
        explicitUserRequest: 'Open conversation search.',
      });
      expect(runDenied.success).toBe(false);
      expect(runDenied.error).toContain('confirm:true');
      expect(fixture.openedSurfaces.filter((surface) => surface.id === 'conversation-search')).toEqual([]);

      const runSearch = await fixture.tool.execute({
        mode: 'run_keybinding',
        actionId: 'search',
        value: 'release notes',
        confirm: true,
        explicitUserRequest: 'Open conversation search for release notes.',
      });
      expect(runSearch.success).toBe(true);
      expect(runSearch.output).toContain('"status": "executed"');
      expect(runSearch.output).toContain('"effect": "conversation-search-opened"');
      expect(fixture.openedSurfaces.at(-1)).toEqual({ id: 'conversation-search', detail: 'release notes' });

      const dismissFixture = makeFixture({ dismissAgentWorkspace: true });
      try {
        const runDismiss = await dismissFixture.tool.execute({
          mode: 'run_keybinding',
          actionId: 'workspace-close',
          confirm: true,
          explicitUserRequest: 'Dismiss the active Agent workspace.',
        });
        expect(runDismiss.success).toBe(true);
        expect(runDismiss.output).toContain('"status": "executed"');
        expect(runDismiss.output).toContain('"effect": "agent-workspace-dismissed"');
        expect(runDismiss.output).toContain('"route": "dismissAgentWorkspace"');
        expect(dismissFixture.openedSurfaces).toEqual([{ id: 'agent-workspace-dismissed', result: true }]);
      } finally {
        dismissFixture.cleanup();
      }

      const surfaceCount = fixture.openedSurfaces.length;
      const unsupportedRun = await fixture.tool.execute({
        mode: 'run_keybinding',
        actionId: 'undo',
        confirm: true,
        explicitUserRequest: 'Undo the last prompt edit.',
      });
      expect(unsupportedRun.success).toBe(true);
      expect(unsupportedRun.output).toContain('"status": "unsupported_keybinding_action"');
      expect(unsupportedRun.output).toContain('"preferredMode": "direct-user-interaction"');
      expect(fixture.openedSurfaces.length).toBe(surfaceCount);

      const denied = await fixture.tool.execute({
        mode: 'set_keybinding',
        actionId: 'search',
        combo: { key: 'g', ctrl: true },
        explicitUserRequest: 'Change search to Ctrl+G.',
      });
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('confirm:true');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);

      const updated = await fixture.tool.execute({
        mode: 'set_keybinding',
        query: 'Ctrl+F',
        combo: { key: 'g', ctrl: true },
        confirm: true,
        explicitUserRequest: 'Change search to Ctrl+G.',
      });
      expect(updated.success).toBe(true);
      expect(updated.output).toContain('"status": "updated"');
      expect(updated.output).toContain('Ctrl+G');
      expect(updated.output).toContain('"resolvedBy": "search"');
      expect(updated.output).toContain('"customized": true');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'g', ctrl: true })).toBe(true);
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(false);

      const reset = await fixture.tool.execute({
        mode: 'reset_keybinding',
        target: 'Toggle conversation search',
        confirm: true,
        explicitUserRequest: 'Reset search keybinding.',
      });
      expect(reset.success).toBe(true);
      expect(reset.output).toContain('"status": "reset"');
      expect(reset.output).toContain('Ctrl+F');
      expect(reset.output).toContain('"source": "target"');
      expect(reset.output).toContain('"customized": false');
      expect(fixture.keybindingsManager.matches('search', { logicalName: 'f', ctrl: true })).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('keeps keybinding discovery available when the live manager is absent', async () => {
    const fixture = makeFixture({ keybindings: false });
    try {
      const listed = await fixture.tool.execute({ mode: 'keybindings', query: 'conversation search' });
      expect(listed.success).toBe(true);
      const listedJson = JSON.parse(listed.output ?? '{}') as {
        readonly status?: string;
        readonly configPath?: string | null;
        readonly keybindings?: readonly { readonly action?: string; readonly source?: string }[];
      };
      expect(listedJson.status).toBe('degraded');
      expect(listedJson.configPath).toBeNull();
      expect(listedJson.keybindings?.[0]?.action).toBe('search');
      expect(listedJson.keybindings?.[0]?.source).toBe('default-fallback');

      const shortcut = await fixture.tool.execute({ mode: 'shortcuts', query: 'shortcut reference' });
      expect(shortcut.success).toBe(true);
      expect(shortcut.output).toContain('"key": "/shortcuts"');
      expect(shortcut.output).toContain('"status": "degraded"');

      const single = await fixture.tool.execute({ mode: 'keybinding', query: 'Ctrl+F' });
      expect(single.success).toBe(true);
      expect(single.output).toContain('"status": "degraded"');
      expect(single.output).toContain('"action": "search"');
      expect(single.output).toContain('Default keybinding descriptor only');

      const run = await fixture.tool.execute({
        mode: 'run_keybinding',
        actionId: 'search',
        confirm: true,
        explicitUserRequest: 'Open conversation search.',
      });
      expect(run.success).toBe(false);
      expect(run.error).toContain('workspace.keybindingsManager is unavailable');
    } finally {
      fixture.cleanup();
    }
  });

  test('reports connected-host capabilities, boundaries, and model tool availability', async () => {
    const fixture = makeFixture();
    try {
      for (const name of [
        'agent_operator_briefing',
        'agent_operator_action',
        'agent_artifacts',
        'agent_knowledge',
        'agent_knowledge_ingest',
        'agent_channel_send',
        'agent_notify',
        'schedule',
        'agent_autonomy_schedule',
        'agent_reminder_schedule',
        'agent_media_generate',
        'agent_model_compare',
        'agent_review_packet_presets',
        'agent_research_runs',
        'agent_research_sources',
        'agent_research_report',
      ]) {
        registerStubTool(fixture.toolRegistry, name);
      }

      const compactResult = await fixture.tool.execute({ mode: 'connected_host' });
      expect(compactResult.success).toBe(true);
      expect(compactResult.output).toContain('"counts"');
      expect(compactResult.output).not.toContain('/api/goodvibes-agent/knowledge/*');
      const compactJson = JSON.parse(compactResult.output ?? '{}') as { readonly modelRoute?: string };
      expectCompactModelRoute(compactJson.modelRoute);

      const daemonAlias = await fixture.tool.execute({ mode: 'daemon' });
      expect(daemonAlias.success).toBe(true);
      expect(JSON.parse(daemonAlias.output!)).toEqual(JSON.parse(compactResult.output!));

      const result = await fixture.tool.execute({ mode: 'connected_host', includeParameters: true });
      expect(result.success, result.error).toBe(true);
      expect(result.output).toContain('"routeFamilies"');
      expect(result.output).toContain('/api/goodvibes-agent/knowledge/*');
      expect(result.output).toContain('"capabilities"');
      expect(result.output).toContain('"agent_operator_action"');
      expect(result.output).toContain('"available": true');
      const expandedJson = JSON.parse(result.output ?? '{}') as {
        readonly capabilities?: readonly Record<string, unknown>[];
        readonly blockedCapabilities?: readonly Record<string, unknown>[];
        readonly routeFamilies?: readonly Record<string, unknown>[];
      };
      expectRowsHaveCompactModelRoutes(expandedJson.capabilities ?? []);
      expectRowsHaveCompactModelRoutes(expandedJson.blockedCapabilities ?? []);
      expectRowsHaveCompactModelRoutes(expandedJson.routeFamilies ?? []);
      expect(result.output).toContain('"blockedCapabilities"');
      expect(result.output).toContain('connected-host-lifecycle');
      expect(result.output).toContain('arbitrary-connected-host-mutations');

      const allowed = await fixture.tool.execute({
        mode: 'connected_host_capability',
        capabilityId: 'agent-knowledge-read',
      });
      expect(allowed.success).toBe(true);
      expect(allowed.output).toContain('"status": "allowed"');
      expect(allowed.output).toContain('"agent_knowledge"');
      expect(allowed.output).toContain('"sources"');
      expect(allowed.output).toContain('"map"');
      expect(allowed.output).toContain('"connector_doctor"');
      expect(allowed.output).toContain('/api/goodvibes-agent/knowledge/*');
      const allowedJson = JSON.parse(allowed.output ?? '{}') as { readonly modelRoute?: string };
      expect(allowedJson.modelRoute).toBe('agent_knowledge');

      const blocked = await fixture.tool.execute({
        mode: 'connected_host_capability',
        capabilityId: 'connected-host-lifecycle',
      });
      expect(blocked.success).toBe(true);
      expect(blocked.output).toContain('"status": "blocked"');
      expect(blocked.output).toContain('start');
      expect(blocked.output).toContain('not exposed to the model as an Agent operation');
      const blockedJson = JSON.parse(blocked.output ?? '{}') as { readonly modelRoute?: string };
      expectCompactModelRoute(blockedJson.modelRoute);

      const blockedByTarget = await fixture.tool.execute({
        mode: 'connected_host_capability',
        target: 'default-knowledge',
      });
      expect(blockedByTarget.success).toBe(true);
      expect(blockedByTarget.output).toContain('"status": "blocked"');
      expect(blockedByTarget.output).toContain('non-agent-knowledge');

      const ambiguous = await fixture.tool.execute({
        mode: 'connected_host_capability',
        query: 'agent',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous connected-host capability agent');
      expect(ambiguous.error).toContain('agent-knowledge-read');
      expect(ambiguous.error).toContain('agent-knowledge-ingest');
      expect(ambiguous.error).toContain('modelRoute');

      const missing = await fixture.tool.execute({
        mode: 'connected_host_capability',
        capabilityId: 'not-a-capability',
      });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown connected-host capability');
    } finally {
      fixture.cleanup();
    }
  });

  test('reports live connected-host status without exposing the operator token', async () => {
    const fixture = makeFixture();
    const originalFetch = globalThis.fetch;
    const token = 'gvop-test-token-value';
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    try {
      writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token }));
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, authorization: readAuthorizationHeader(init?.headers) });
        if (url.endsWith('/status')) {
          return new Response(JSON.stringify({ status: 'running' }), { status: 200 });
        }
        if (url.endsWith('/api/goodvibes-agent/knowledge/status')) {
          return new Response(JSON.stringify({ ready: true }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as typeof globalThis.fetch;

      const result = await fixture.tool.execute({ mode: 'connected_host_status' });
      expect(result.success, result.error).toBe(true);
      if (!result.success) throw new Error(result.error);
      const payload = JSON.parse(result.output!) as {
        readonly modelRoute?: string;
        readonly liveStatus: {
          readonly reachable: boolean;
          readonly compatible: boolean;
          readonly agentKnowledge: { readonly ready: boolean };
        };
        readonly operatorToken: {
          readonly usable: boolean;
          readonly fingerprint: string | null;
        };
      };
      expectCompactModelRoute(payload.modelRoute);
      expect(payload.liveStatus.reachable).toBe(true);
      expect(payload.operatorToken.usable).toBe(true);
      expect(payload.operatorToken.fingerprint?.startsWith('sha256:')).toBe(true);
      expect(result.output).not.toContain(token);

      const alias = await fixture.tool.execute({ mode: 'daemon_status' });
      expect(alias.success).toBe(true);
      if (!alias.success) throw new Error(alias.error);
      const aliasPayload = JSON.parse(alias.output!) as typeof payload;
      expectCompactModelRoute(aliasPayload.modelRoute);
      expect(aliasPayload.liveStatus.reachable).toBe(true);
      expect(aliasPayload.operatorToken.usable).toBe(true);
      expect(alias.output).not.toContain(token);
      expect(requests.map((request) => request.url)).toEqual([
        'http://127.0.0.1:3421/status',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/status',
        'http://127.0.0.1:3421/status',
        'http://127.0.0.1:3421/api/goodvibes-agent/knowledge/status',
      ]);
      expect(requests.map((request) => request.authorization)).toEqual(Array(4).fill(`Bearer ${token}`));
    } finally {
      globalThis.fetch = originalFetch;
      fixture.cleanup();
    }
  });

  test('uses the canonical TUI editor schema for learned behavior actions', async () => {
    const fixture = makeFixture();
    try {
      const action = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'learned-behavior' });

      expect(action.success).toBe(true);
      expect(action.output).toContain('"editorKind": "learned-behavior"');
      expect(action.output).toContain('Ctrl-J inserts a new line.');
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes a model-visible editor schema for every user-facing workspace editor action', async () => {
    const fixture = makeFixture();
    try {
      const editorActions = AGENT_WORKSPACE_CATEGORIES.flatMap((category) => (
        category.actions
          .filter((action) => action.kind === 'editor' && action.editorKind)
          .map((action) => ({ category, action }))
      ));

      expect(editorActions.length).toBeGreaterThan(0);
      for (const { action } of editorActions) {
        const result = await fixture.tool.execute({ mode: 'workspace_action', actionId: action.id });
        expect(result.success, action.id).toBe(true);
        expect(result.output, action.id).toContain('"editor"');
        expect(result.output, action.id).toContain('"fields"');
        expect(result.output, action.id).toContain('"modelExecution"');
      }

      const compare = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'document-run-compare' });
      expect(compare.success).toBe(true);
      expect(compare.output).toContain('"id": "artifactId"');
      expect(compare.output).toContain('Optional saved text artifact id');
    } finally {
      fixture.cleanup();
    }
  });

  test('classifies workspace editor model execution routes by route type', async () => {
    const fixture = makeFixture();
    try {
      const local = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'memory-create' });
      const commandBacked = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'conversation-save' });
      const promptBacked = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-main' });
      const researchRun = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-start-run' });
      const researchSource = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-add-source' });
      const researchReport = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'research-save-report' });
      const directLocal = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'learned-behavior' });
      const profile = await fixture.tool.execute({ mode: 'workspace_action', actionId: 'runtime-profile-create' });

      expect(local.success).toBe(true);
      expect(commandBacked.success).toBe(true);
      expect(promptBacked.success).toBe(true);
      expect(researchRun.success).toBe(true);
      expect(researchSource.success).toBe(true);
      expect(researchReport.success).toBe(true);
      expect(directLocal.success).toBe(true);
      expect(profile.success).toBe(true);

      expect(JSON.parse(local.output!).modelExecution).toMatchObject({
        route: 'agent_local_registry',
        tool: 'agent_local_registry',
        domain: 'memory',
      });
      expect(JSON.parse(commandBacked.output!).modelExecution).toMatchObject({
        route: 'slash-command-dispatch',
        dispatcher: 'run_command',
        confirmation: 'required',
      });
      expect(JSON.parse(promptBacked.output!).modelExecution).toMatchObject({
        route: 'main-conversation-prompt',
        result: 'prompt',
        confirmation: 'not-required',
      });
      expect(JSON.parse(researchRun.output!).modelExecution).toMatchObject({
        route: 'agent_research_runs',
        tool: 'agent_research_runs',
        action: 'create_research_run',
        confirmation: 'required',
      });
      expect(JSON.parse(researchSource.output!).modelExecution).toMatchObject({
        route: 'agent_research_sources',
        tool: 'agent_research_sources',
        action: 'add_source_candidate',
        confirmation: 'required',
      });
      expect(JSON.parse(researchReport.output!).modelExecution).toMatchObject({
        route: 'agent_research_report',
        tool: 'agent_research_report',
        action: 'save_research_report_artifact',
        confirmation: 'required',
      });
      expect(JSON.parse(directLocal.output!).modelExecution).toMatchObject({
        route: 'direct-agent-local-create',
        action: 'create_learned_behavior',
      });
      expect(JSON.parse(profile.output!).modelExecution).toMatchObject({
        route: 'slash-command-dispatch',
        command: '/agent-profile create <name> [--template <template>] --yes',
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('exposes model execution metadata for every local workspace action', async () => {
    const fixture = makeFixture();
    try {
      const localActions = AGENT_WORKSPACE_CATEGORIES.flatMap((category) => (
        category.actions
          .filter((action) => action.kind === 'local-selection' || action.kind === 'local-operation')
          .map((action) => ({ category, action }))
      ));

      expect(localActions.length).toBeGreaterThan(0);
      for (const { action } of localActions) {
        const result = await fixture.tool.execute({ mode: 'workspace_action', actionId: action.id });
        expect(result.success, action.id).toBe(true);
        expect(result.output, action.id).toContain('"modelExecution"');
        expect(result.output!.includes('agent_local_registry') || result.output!.includes('agent_knowledge_ingest'), action.id).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('requires confirmation before invoking slash commands through the harness', async () => {
    const fixture = makeFixture();
    try {
      const preview = await fixture.tool.execute({
        mode: 'run_command',
        command: '/brief',
        explicitUserRequest: 'Show the briefing.',
      });
      expect(preview.success).toBe(false);
      expect(preview.error).toContain('confirm:true');
      expect(fixture.printed).toEqual([]);

      const executed = await fixture.tool.execute({
        mode: 'run_command',
        command: '/brief',
        confirm: true,
        explicitUserRequest: 'Show the briefing.',
      });
      expect(executed.success).toBe(true);
      expect(executed.output).toContain('Command /brief completed.');
      expect(executed.output).toContain('briefing output');
    } finally {
      fixture.cleanup();
    }
  });

  test('describes native work navigation without bypassing slash command confirmation', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const inspected = await fixture.tool.execute({ mode: 'command', command: '/work daemon-project' });
      expect(inspected.success).toBe(true);
      if (!inspected.success) throw new Error(inspected.error);
      const payload = JSON.parse(inspected.output!) as {
        readonly policy: { readonly effect: string; readonly preferredModelTool: string; readonly confirmation: string; readonly boundary: string };
        readonly lookup: { readonly parsedArgs: readonly string[] };
      };
      expect(payload.policy.effect).toBe('ui-navigation');
      expect(payload.policy.preferredModelTool).toBe('agent_harness mode:"run_command" commandName:"work"');
      expect(payload.policy.confirmation).toContain('confirm:true and explicitUserRequest');
      expect(payload.policy.boundary).toContain('native read-only work ledger');
      expect(payload.policy.boundary).toContain('existing read permissions');
      expect(payload.policy.boundary).toContain('access revocation invalidate the view');
      expect(payload.lookup.parsedArgs).toEqual(['daemon-project']);
      expect(fixture.openedSurfaces).toEqual([]);

      for (const approval of [{ explicitUserRequest: 'Open the native work ledger.' }, { confirm: true }]) {
        const refused = await fixture.tool.execute({ mode: 'run_command', command: '/work', ...approval });
        expect(refused.success).toBe(false);
        expect(fixture.openedSurfaces).toEqual([]);
      }
      const opened = await fixture.tool.execute({
        mode: 'run_command', command: '/work', confirm: true,
        explicitUserRequest: 'Open the native work ledger.',
      });
      expect(opened.success).toBe(true);
      expect(fixture.openedSurfaces).toEqual([{ id: 'agent-workspace', detail: 'work' }]);
    } finally {
      fixture.cleanup();
    }
  });

  test('runs slash commands through the shared command lookup resolver', async () => {
    const fixture = makeFixture();
    try {
      fixture.commandRegistry.register({
        name: 'echoargs',
        description: 'Echo command arguments for resolver coverage',
        handler: (args, ctx) => {
          ctx.print(`args:${args.join('|')}`);
        },
      });
      fixture.commandRegistry.register({
        name: 'memory',
        aliases: ['mem'],
        description: 'Manage Agent-local memory records',
        usage: '<action>',
        handler: (_args, ctx) => {
          ctx.print('memory output');
        },
      });
      fixture.commandRegistry.register({
        name: 'memory-review',
        description: 'Review Agent-local memory records',
        usage: '<id>',
        handler: (_args, ctx) => {
          ctx.print('memory review output');
        },
      });

      const byCommandName = await fixture.tool.execute({
        mode: 'run_command',
        commandName: 'ECHOARGS',
        args: ['one', 'two'],
        confirm: true,
        explicitUserRequest: 'Run echoargs with two arguments.',
      });
      expect(byCommandName.success).toBe(true);
      expect(byCommandName.output).toContain('Command /echoargs completed.');
      expect(byCommandName.output).toContain('Resolved by commandName case-insensitive-name.');
      expect(byCommandName.output).toContain('args:one|two');

      const byQuery = await fixture.tool.execute({
        mode: 'run_command',
        query: 'Test briefing command',
        confirm: true,
        explicitUserRequest: 'Show the briefing.',
      });
      expect(byQuery.success).toBe(true);
      expect(byQuery.output).toContain('Command /brief completed.');
      expect(byQuery.output).toContain('Resolved by query description.');
      expect(byQuery.output).toContain('briefing output');

      const ambiguous = await fixture.tool.execute({
        mode: 'run_command',
        query: 'Agent-local memory records',
        confirm: true,
        explicitUserRequest: 'Run the memory command.',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous slash command');
      expect(ambiguous.error).toContain('"name":"memory"');
      expect(ambiguous.error).toContain('"name":"memory-review"');
      expect(fixture.printed).not.toContain('memory output');
      expect(fixture.printed).not.toContain('memory review output');
    } finally {
      fixture.cleanup();
    }
  });

  test('inspects one slash command from typed command, target, query, and alias lookups', async () => {
    const fixture = makeFixture();
    try {
      fixture.commandRegistry.register({
        name: 'memory',
        aliases: ['mem'],
        description: 'Manage Agent-local memory records',
        usage: '<action>',
        handler: () => {},
      });
      fixture.commandRegistry.register({
        name: 'memory-review',
        description: 'Review Agent-local memory records',
        usage: '<id>',
        handler: () => {},
      });

      const typed = await fixture.tool.execute({ mode: 'command', command: '/mem list --reviewed' });
      expect(typed.success).toBe(true);
      if (!typed.success) throw new Error(typed.error);
      const typedPayload = JSON.parse(typed.output!) as {
        readonly name: string;
        readonly lookup: {
          readonly source: string;
          readonly parsedName: string;
          readonly parsedArgs: readonly string[];
          readonly resolvedBy: string;
        };
        readonly policy: { readonly preferredModelTool?: string };
      };
      expect(typedPayload.name).toBe('memory');
      expect(typedPayload.lookup.source).toBe('command');
      expect(typedPayload.lookup.parsedName).toBe('mem');
      expect(typedPayload.lookup.parsedArgs).toEqual(['list', '--reviewed']);
      expect(typedPayload.lookup.resolvedBy).toBe('alias');
      expect(typedPayload.policy.preferredModelTool).toBe('agent_local_registry');

      const target = await fixture.tool.execute({ mode: 'command', target: '/BRIEF' });
      expect(target.success).toBe(true);
      expect(target.output).toContain('"resolvedBy": "case-insensitive-name"');
      expect(target.output).toContain('"name": "brief"');

      const described = await fixture.tool.execute({ mode: 'command', query: 'Test briefing command' });
      expect(described.success).toBe(true);
      expect(described.output).toContain('"resolvedBy": "description"');
      expect(described.output).toContain('"name": "brief"');

      const ambiguous = await fixture.tool.execute({ mode: 'command', query: 'Agent-local memory records' });
      expect(ambiguous.success).toBe(true);
      expect(ambiguous.output).toContain('"status": "ambiguous"');
      expect(ambiguous.output).toContain('"name": "memory"');
      expect(ambiguous.output).toContain('"name": "memory-review"');

      const missing = await fixture.tool.execute({ mode: 'command', query: 'not-a-command' });
      expect(missing.success).toBe(false);
      expect(missing.error).toContain('Unknown slash command');
      expect(missing.error).toContain('mode:"commands"');
    } finally {
      fixture.cleanup();
    }
  });

  test('assigns concrete model policy metadata to every built-in slash command', () => {
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);

    const unknownPolicies = registry.list()
      .filter((command) => describeCommandPolicy(command.name).effect === 'unknown')
      .map((command) => command.name)
      .sort((a, b) => a.localeCompare(b));
    expect(unknownPolicies).toEqual([]);

    const missingPreferredRoutes = registry.list()
      .filter((command) => !describeCommandPolicy(command.name).preferredModelTool)
      .map((command) => command.name)
      .sort((a, b) => a.localeCompare(b));
    expect(missingPreferredRoutes).toEqual([]);

    const staleHarnessRoutes = registry.list()
      .map((command) => [command.name, describeCommandPolicy(command.name).preferredModelTool ?? ''] as const)
      .filter(([, route]) => /agent_harness (?!mode:")/.test(route))
      .map(([command, route]) => `${command}: ${route}`)
      .sort((a, b) => a.localeCompare(b));
    expect(staleHarnessRoutes).toEqual([]);

    expect(describeCommandPolicy('agent')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
    // /context window <size> writes a persisted override: never labelled read-only.
    expect(describeCommandPolicy('context')).toMatchObject({ effect: 'mixed' });
    expect(describeCommandPolicy('context').boundary).toContain('/context window <size> writes');
    expect(describeCommandPolicy('status').effect).toBe('read-only');
    expect(describeCommandPolicy('brief')).toMatchObject({
      effect: 'read-only',
      preferredModelTool: 'agent_operator_briefing',
    });
    expect(describeCommandPolicy('refresh-models')).toMatchObject({
      effect: 'external-network',
    });
    expect(describeCommandPolicy('export')).toMatchObject({
      effect: 'local-state',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
    expect(describeCommandPolicy('delegate')).toMatchObject({
      effect: 'delegated-work',
      preferredModelTool: expect.stringContaining('run_workspace_action'),
    });
    expect(describeCommandPolicy('next-error')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: 'agent_harness mode:"run_command"',
    });
    expect(describeCommandPolicy('clear')).toMatchObject({
      effect: 'session-lifecycle',
      preferredModelTool: expect.stringContaining('run_command'),
    });
    expect(describeCommandPolicy('notes')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: expect.stringContaining('agent_local_registry'),
    });
    expect(describeCommandPolicy('bookmarks')).toMatchObject({
      effect: 'ui-navigation',
      preferredModelTool: expect.stringContaining('open_ui_surface'),
    });
    expect(describeCommandPolicy('bookmarks').preferredModelTool).toContain('run_command');
    expect(describeCommandPolicy('keybindings')).toMatchObject({
      effect: 'read-only',
      preferredModelTool: expect.stringContaining('run_keybinding'),
    });
  });

  test('assigns preferred model routes to every supported top-level CLI mirror', () => {
    const missingPreferredRoutes = listGoodVibesCliCommands()
      .filter((command) => command !== 'unknown')
      .filter((command) => !describeCliCommandPolicy(command).preferredModelTool)
      .sort((a, b) => a.localeCompare(b));
    expect(missingPreferredRoutes).toEqual([]);

    const staleHarnessRoutes = listGoodVibesCliCommands()
      .filter((command) => command !== 'unknown')
      .map((command) => [command, describeCliCommandPolicy(command).preferredModelTool ?? ''] as const)
      .filter(([, route]) => /agent_harness (?!mode:")/.test(route))
      .map(([command, route]) => `${command}: ${route}`)
      .sort((a, b) => a.localeCompare(b));
    expect(staleHarnessRoutes).toEqual([]);

    expect(describeCliCommandPolicy('run')).toMatchObject({
      effect: 'mixed',
      preferredModelTool: expect.stringContaining('current Agent conversation'),
    });
    expect(describeCliCommandPolicy('delegate')).toMatchObject({
      effect: 'delegated-work',
      preferredModelTool: expect.stringContaining('run_workspace_action'),
    });
    expect(describeCliCommandPolicy('pair')).toMatchObject({
      effect: 'external-network',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
    expect(describeCliCommandPolicy('secrets')).toMatchObject({
      effect: 'mixed',
      preferredModelTool: expect.stringContaining('settings'),
    });
    expect(describeCliCommandPolicy('subscription')).toMatchObject({
      effect: 'mixed',
      preferredModelTool: expect.stringContaining('workspace_actions'),
    });
  });

  // DELETED: 'runs command-backed workspace actions through id and command lookups'
  // brief action was removed from the workspace.;

  test('previews and applies GoodVibes settings import through workspace action route', async () => {
    const fixture = makeFixture();
    try {
      const nextSaveHistory = !Boolean(fixture.configManager.get('behavior.saveHistory'));
      mkdirSync(fixture.paths.resolveUserPath('tui'), { recursive: true });
      writeFileSync(fixture.paths.resolveUserPath('tui', 'settings.json'), JSON.stringify({
        behavior: { saveHistory: nextSaveHistory },
        surfaces: {
          slack: { botToken: 'xoxb-import-secret' },
        },
      }, null, 2));

      const preview = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'import-goodvibes-tui-settings',
      });
      expect(preview.success).toBe(true);
      expect(preview.output).toContain('"status": "confirmation_required"');
      expect(preview.output).toContain('"settingsToImport": 2');
      expect(preview.output).toContain('<redacted>');
      expect(preview.output).not.toContain('xoxb-import-secret');
      expect(fixture.configManager.get('behavior.saveHistory')).toBe(!nextSaveHistory);

      const missingUserRequest = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'import-goodvibes-tui-settings',
        confirm: true,
      });
      expect(missingUserRequest.success).toBe(false);
      expect(missingUserRequest.error).toContain('explicitUserRequest');

      const applied = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'import-goodvibes-tui-settings',
        confirm: true,
        explicitUserRequest: 'Import my existing GoodVibes settings into Agent.',
      });
      expect(applied.success).toBe(true);
      expect(applied.output).toContain('GoodVibes settings imported');
      expect(applied.output).not.toContain('xoxb-import-secret');
      expect(fixture.configManager.get('behavior.saveHistory')).toBe(nextSaveHistory);
      expect(fixture.configManager.get('surfaces.slack.botToken')).toBe(
        buildGoodVibesSecretRef(buildGoodVibesSecretKey('surfaces.slack.botToken')),
      );
      expect(await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe('xoxb-import-secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('runs workspace actions by target and query without guessing ambiguous requests', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      fixture.toolRegistry.register(createAgentLocalRegistryTool(fixture.paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry)));

      const targetRun = await fixture.tool.execute({
        mode: 'run_workspace_action',
        categoryId: 'notes',
        target: 'Create note',
        fields: {
          title: 'Lookup mirror note',
          body: 'Target lookup should execute the same workspace editor as an exact action id.',
          tags: 'harness,lookup',
        },
        confirm: true,
        explicitUserRequest: 'Create a note through workspace action lookup.',
      });
      expect(targetRun.success).toBe(true);
      expect(targetRun.output).toContain('"status": "executed_model_tool"');
      expect(targetRun.output).toContain('Created Agent-local note');
      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).get('lookup-mirror-note');
      expect(note?.body).toContain('Target lookup should execute');

      const queryRun = await fixture.tool.execute({
        mode: 'run_workspace_action',
        query: 'durable non-secret default knowledge fallback',
        fields: {
          summary: 'Lookup execution preserves Agent-local memory only.',
          detail: 'Query lookup should execute the same workspace editor as an exact memory action id.',
          tags: 'harness,lookup',
        },
        confirm: true,
        explicitUserRequest: 'Create a memory through workspace action lookup.',
      });
      expect(queryRun.success).toBe(true);
      expect(queryRun.output).toContain('"status": "executed_model_tool"');
      expect(queryRun.output).toContain('Created Agent-local memory');
      expect(memoryRegistry.getAll().map((entry) => entry.summary)).toContain('Lookup execution preserves Agent-local memory only.');

      const ambiguous = await fixture.tool.execute({
        mode: 'run_workspace_action',
        query: 'memory',
        confirm: true,
        explicitUserRequest: 'Run the memory action.',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous Agent workspace action memory');
      expect(ambiguous.error).toContain('memory-create');
    } finally {
      fixture.cleanup();
    }
  });

  test('routes selection-based local workspace actions through model tools', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      fixture.toolRegistry.register(createAgentLocalRegistryTool(fixture.paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry)));
      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).create({
        title: 'Daily triage',
        body: 'Read the queue, sort urgent items first, and summarize blocked work.',
        tags: ['workflow'],
        source: 'agent',
        provenance: 'test',
      });

      const preview = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-to-skill',
        recordId: note.id,
      });
      expect(preview.success).toBe(true);
      expect(preview.output).toContain('"status": "editor"');
      expect(preview.output).toContain('Create Skill From Note');
      expect(preview.output).toContain('Read the queue');

      const promoted = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-to-skill',
        recordId: note.id,
        fields: { enabled: 'yes' },
        confirm: true,
        explicitUserRequest: 'Promote the triage note into a skill.',
      });
      expect(promoted.success).toBe(true);
      expect(promoted.output).toContain('executed_model_tool');
      const skill = AgentSkillRegistry.fromShellPaths(fixture.paths).get('daily-triage');
      expect(skill?.procedure).toContain('Read the queue');
      expect(skill?.enabled).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('runs direct local create workspace editors through model tools', async () => {
    const fixture = makeFixture();
    try {
      const memoryRegistry = await createMemoryRegistry(fixture.paths, fixture.configManager);
      fixture.toolRegistry.register(createAgentLocalRegistryTool(fixture.paths, memoryRegistry, createLocalMemoryAccess(memoryRegistry)));

      const missingFields = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-create',
        fields: { title: 'Source triage' },
        confirm: true,
        explicitUserRequest: 'Create a source-triage note.',
      });
      expect(missingFields.success).toBe(true);
      expect(missingFields.output).toContain('"status": "missing_required_fields"');
      expect(missingFields.output).toContain('"body"');

      const created = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'notes-create',
        fields: {
          title: 'Source triage',
          body: 'Capture reviewed sources before deciding what belongs in Agent Knowledge.',
          tags: 'research,triage',
        },
        confirm: true,
        explicitUserRequest: 'Create a source-triage note.',
      });
      expect(created.success).toBe(true);
      expect(created.output).toContain('"status": "executed_model_tool"');
      expect(created.output).toContain('Created Agent-local note');

      const note = AgentNoteRegistry.fromShellPaths(fixture.paths).get('source-triage');
      expect(note?.title).toBe('Source triage');
      expect(note?.body).toContain('reviewed sources');
      expect(note?.tags).toEqual(['research', 'triage']);
    } finally {
      fixture.cleanup();
    }
  });

  test('runs Agent document workspace editors through agent_documents', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      fixture.toolRegistry.register(createAgentDocumentsTool(fixture.paths, artifacts.store));

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-create-draft',
        confirm: true,
        explicitUserRequest: 'Create a launch document draft.',
        fields: {
          title: 'Launch Plan',
          body: 'Initial launch draft.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');

      const created = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-create-draft',
        confirm: true,
        explicitUserRequest: 'Create a launch document draft.',
        fields: {
          title: 'Launch Plan',
          body: 'Initial launch draft.',
          tags: 'launch,docs',
          confirm: 'yes',
        },
      });
      expect(created.success).toBe(true);
      expect(created.output).toContain('"tool": "agent_documents"');
      expect(created.output).toContain('Created Agent document');
      expect(created.output).toContain('launch-plan');

      const revised = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-revise-draft',
        confirm: true,
        explicitUserRequest: 'Revise the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          body: 'Initial launch draft.\n\nAdd rollout checklist.',
          changeSummary: 'Added rollout checklist.',
          confirm: 'yes',
        },
      });
      expect(revised.success).toBe(true);
      expect(revised.output).toContain('versions 2');

      const commented = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-comment-draft',
        confirm: true,
        explicitUserRequest: 'Add a review comment to the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          comment: 'Confirm launch owner.',
          confirm: 'yes',
        },
      });
      expect(commented.success).toBe(true);
      expect(commented.output).toContain('"tool": "agent_documents"');
      expect(commented.output).toContain('Added Agent document comment');
      expect(commented.output).toContain('comment c1');

      const resolvedComment = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-resolve-comment',
        confirm: true,
        explicitUserRequest: 'Resolve the launch document review comment.',
        fields: {
          documentId: 'launch-plan',
          commentId: 'c1',
          confirm: 'yes',
        },
      });
      expect(resolvedComment.success).toBe(true);
      expect(resolvedComment.output).toContain('Resolved Agent document comment');

      const suggested = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-suggest-draft',
        confirm: true,
        explicitUserRequest: 'Propose an AI suggestion for the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          body: 'Initial launch draft.\n\nAdd rollout checklist.\n\nOwner: Launch team.',
          changeSummary: 'Added launch owner.',
          suggestionRationale: 'The launch plan needs a visible owner before review.',
          confirm: 'yes',
        },
      });
      expect(suggested.success).toBe(true);
      expect(suggested.output).toContain('"tool": "agent_documents"');
      expect(suggested.output).toContain('Added Agent document suggestion');
      expect(suggested.output).toContain('suggestion s1');
      expect(suggested.output).toContain('versions 2');

      const acceptedSuggestion = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-accept-suggestion',
        confirm: true,
        explicitUserRequest: 'Accept the launch document suggestion.',
        fields: {
          documentId: 'launch-plan',
          suggestionId: 's1',
          confirm: 'yes',
        },
      });
      expect(acceptedSuggestion.success).toBe(true);
      expect(acceptedSuggestion.output).toContain('Accepted Agent document suggestion');
      expect(acceptedSuggestion.output).toContain('versions 3');

      const rejectCandidate = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-suggest-draft',
        confirm: true,
        explicitUserRequest: 'Propose a second launch document suggestion.',
        fields: {
          documentId: 'launch-plan',
          body: 'Rejected launch rewrite.',
          changeSummary: 'Alternative rewrite.',
          suggestionRationale: 'This is a less useful option.',
          confirm: 'yes',
        },
      });
      expect(rejectCandidate.success).toBe(true);
      expect(rejectCandidate.output).toContain('suggestion s2');

      const rejectedSuggestion = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-reject-suggestion',
        confirm: true,
        explicitUserRequest: 'Reject the second launch document suggestion.',
        fields: {
          documentId: 'launch-plan',
          suggestionId: 's2',
          confirm: 'yes',
        },
      });
      expect(rejectedSuggestion.success).toBe(true);
      expect(rejectedSuggestion.output).toContain('Rejected Agent document suggestion');
      expect(rejectedSuggestion.output).toContain('versions 3');

      const sourceArtifact = await artifacts.store.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: 'source-note.md',
        text: 'Reusable source note.',
        metadata: { purpose: 'source-note' },
      });
      const attached = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-attach-artifact',
        confirm: true,
        explicitUserRequest: 'Attach the source artifact to the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          artifactId: sourceArtifact.id,
          attachmentLabel: 'Source Note',
          attachmentNote: 'Reusable evidence for this draft.',
          confirm: 'yes',
        },
      });
      expect(attached.success).toBe(true);
      expect(attached.output).toContain('"tool": "agent_documents"');
      expect(attached.output).toContain('Attached artifact to Agent document');
      expect(attached.output).toContain('attachments 1');
      expect(attached.output).toContain('versions 3');

      const inserted = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-insert-artifact',
        confirm: true,
        explicitUserRequest: 'Insert the source artifact into the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          artifactId: sourceArtifact.id,
          sectionTitle: 'Source Note',
          confirm: 'yes',
        },
      });
      expect(inserted.success).toBe(true);
      expect(inserted.output).toContain('"tool": "agent_documents"');
      expect(inserted.output).toContain('Inserted artifact into Agent document');
      expect(inserted.output).toContain('versions 4');

      const exported = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-draft',
        confirm: true,
        explicitUserRequest: 'Export the launch document draft.',
        fields: {
          documentId: 'launch-plan',
          confirm: 'yes',
        },
      });
      expect(exported.success).toBe(true);
      expect(exported.output).toContain('Exported Agent document');
      expect(artifacts.store.list(5)[0]?.metadata).toMatchObject({
        purpose: 'agent-document-export',
        documentId: 'launch-plan',
        attachmentIds: [sourceArtifact.id],
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('runs review packet preset workspace editor through agent_review_packet_presets', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      fixture.toolRegistry.register(createAgentReviewPacketPresetsTool(artifacts.store));
      const documentRegistry = AgentDocumentRegistry.fromShellPaths(fixture.paths);
      const draft = documentRegistry.create({
        title: 'Launch Packet',
        body: 'Reviewed launch packet body.',
        tags: ['launch'],
      });
      const docExport = await artifacts.store.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: 'launch-packet.md',
        text: '# Launch Packet',
        metadata: {
          purpose: 'agent-document-export',
          documentId: draft.id,
          versionId: draft.versions.at(-1)?.id ?? '',
        },
      });
      const revealedJudgment = await artifacts.store.create({
        kind: 'data',
        mimeType: 'application/json',
        filename: 'blind-model-comparison-judgment-launch.json',
        text: '{}',
        metadata: {
          purpose: 'agent-model-compare-judgment',
          judgmentId: 'jdg_launch',
          comparisonId: 'cmp_launch',
          winnerBlindId: 'B',
          winnerModel: 'openai:gpt-5.5',
          revealIncludedInJudgment: true,
        },
      });

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-save-review-packet-preset',
        confirm: true,
        explicitUserRequest: 'Save the current review packet preset.',
        fields: {
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');
      expect(unconfirmed.output).toContain('Launch Packet preset');
      expect(unconfirmed.output).toContain(docExport.id);
      expect(unconfirmed.output).toContain(revealedJudgment.id);

      const saved = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-save-review-packet-preset',
        confirm: true,
        explicitUserRequest: 'Save the current review packet preset.',
        fields: {
          name: 'Launch packet reviewer preset',
          documentId: draft.id,
          documentTitle: 'Launch Packet',
          documentExportArtifactId: docExport.id,
          revealedJudgmentArtifactId: revealedJudgment.id,
          relatedArtifactIds: `${docExport.id}\n${revealedJudgment.id}`,
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_review_packet_presets"');
      expect(saved.output).toContain('Review packet preset saved');
      expect(artifacts.store.list(1)[0]?.metadata).toMatchObject({
        purpose: 'agent-review-packet-preset',
        name: 'Launch packet reviewer preset',
        documentId: draft.id,
        documentExportArtifactId: docExport.id,
        revealedJudgmentArtifactId: revealedJudgment.id,
        relatedArtifactIds: [docExport.id, revealedJudgment.id],
      });

      const savedPresetId = artifacts.store.list(1)[0]?.id;
      expect(savedPresetId).toBeTruthy();
      const newerDocExport = await artifacts.store.create({
        kind: 'document',
        mimeType: 'text/markdown',
        filename: 'launch-packet-v2.md',
        text: '# Launch Packet v2',
        metadata: {
          purpose: 'agent-document-export',
          documentId: draft.id,
          versionId: `${draft.versions.at(-1)?.id ?? ''}-refresh`,
        },
      });
      const refreshed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-refresh-review-packet-preset',
        confirm: true,
        explicitUserRequest: 'Refresh the stale review packet preset.',
        fields: {
          artifactId: savedPresetId ?? '',
          name: 'Launch packet refreshed preset',
          confirm: 'yes',
        },
      });
      expect(refreshed.success).toBe(true);
      expect(refreshed.output).toContain('"status": "executed_model_tool"');
      expect(refreshed.output).toContain('"tool": "agent_review_packet_presets"');
      expect(refreshed.output).toContain('Review packet preset refreshed');
      expect(artifacts.store.list(1)[0]?.metadata).toMatchObject({
        purpose: 'agent-review-packet-preset',
        name: 'Launch packet refreshed preset',
        documentId: draft.id,
        documentExportArtifactId: newerDocExport.id,
        refreshOfArtifactId: savedPresetId ?? '',
      });
      const wizard = await executeHarnessJson<{
        readonly reviewPacketWizard?: {
          readonly finalReview?: string;
          readonly presetLineage?: {
            readonly artifactId: string;
            readonly refreshed: boolean;
            readonly refreshedFromArtifactId: string | null;
            readonly freshnessSupersededCount: number | null;
            readonly summary: string;
            readonly inspectRoute: string;
          };
        };
      }>(fixture, { mode: 'document_ops_lane', laneId: 'review_packet_wizard', includeParameters: true });
      expect(wizard.reviewPacketWizard?.presetLineage).toMatchObject({
        artifactId: artifacts.store.list(1)[0]?.id,
        refreshed: true,
        refreshedFromArtifactId: savedPresetId,
        freshnessSupersededCount: 1,
      });
      expect(wizard.reviewPacketWizard?.presetLineage?.summary).toContain('refreshed from');
      expect(wizard.reviewPacketWizard?.presetLineage?.inspectRoute).toContain('agent_review_packet_presets show');
    } finally {
      fixture.cleanup();
    }
  });

  test('runs review packet share workspace editor through agent_review_packet_share', async () => {
    const artifacts = createHarnessArtifactStore();
    const channelRequests: ChannelDeliveryRequest[] = [];
    const archive = await artifacts.store.create({
      kind: 'archive',
      mimeType: 'application/zip',
      filename: 'launch-handoff-archive.zip',
      text: 'zip-bytes-never-printed',
      metadata: {
        purpose: 'agent-model-compare-handoff-archive',
        archiveId: 'hndarc_launch',
        handoffArtifactId: 'artifact-handoff',
        handoffId: 'hnd_launch',
        sourceArtifactId: 'artifact-judgment',
        sourceKind: 'judgment',
        relatedArtifactIds: ['artifact-doc'],
        routeDecisionArtifactIds: ['artifact-route'],
        includedArtifactIds: ['artifact-handoff', 'artifact-judgment', 'artifact-doc', 'artifact-route'],
        comparisonId: 'cmp_launch',
        artifactCount: 4,
        archiveBytes: 4096,
        revealIncludedInHandoff: true,
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      fixture.toolRegistry.register(createAgentReviewPacketShareTool(
        artifacts.store,
        fakeChannelDeliveryRouter(channelRequests),
      ));

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-share-review-packet',
        confirm: true,
        explicitUserRequest: 'Share the current review packet.',
        fields: {
          channel: 'slack:review:Review',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');
      expect(unconfirmed.output).toContain(archive.id);
      expect(channelRequests).toEqual([]);

      const shared = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-share-review-packet',
        confirm: true,
        explicitUserRequest: 'Share the current review packet with the review channel.',
        fields: {
          archiveArtifactId: archive.id,
          title: 'Launch packet',
          message: 'Please review the final packet.',
          channel: 'slack:review:Review',
          confirm: 'yes',
        },
      });
      expect(shared.success).toBe(true);
      expect(shared.output).toContain('"status": "executed_model_tool"');
      expect(shared.output).toContain('"tool": "agent_review_packet_share"');
      expect(shared.output).toContain('Agent review packet shared');
      expect(shared.output).not.toContain('zip-bytes-never-printed');
      const sharedPayload = JSON.parse(shared.output ?? '{}') as { readonly output?: string | null };
      expect(sharedPayload.output).toContain('agent_artifacts mode:"export" artifactId:"artifact-1"');
      expect(channelRequests).toHaveLength(1);
      expect(channelRequests[0]?.body).toContain('Please review the final packet.');
      expect(channelRequests[0]?.body).toContain('Archive: artifact-1');
      expect(channelRequests[0]?.body).toContain('Included artifacts: 4');
    } finally {
      fixture.cleanup();
    }
  });

  test('runs artifact browser workspace editors through agent_artifacts', async () => {
    const artifacts = createHarnessArtifactStore();
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'text/markdown',
      filename: 'comparison-export.md',
      text: 'Saved comparison report\n\nThe winning answer was more concrete.',
      metadata: {
        purpose: 'agent-model-compare-export',
        source: 'agent-model-compare',
        apiKey: 'not-for-transcript',
      },
    });
    await artifacts.store.create({
      kind: 'data',
      mimeType: 'application/json',
      filename: 'comparison-judgment.json',
      text: '{"winner":"A","reason":"More concrete"}',
      metadata: {
        purpose: 'agent-model-compare-judgment',
        source: 'agent-model-compare',
        secretToken: 'not-for-package',
      },
    });
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      fixture.toolRegistry.register(createAgentArtifactsTool(artifacts.store, { projectRoot: fixture.root }));
      registerStubTool(fixture.toolRegistry, 'agent_knowledge_ingest');

      const browse = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'artifact-browse',
        fields: {
          purpose: 'model-compare-export',
          limit: '10',
        },
      });
      expect(browse.success).toBe(true);
      expect(browse.output).toContain('"status": "executed_model_tool"');
      expect(browse.output).toContain('"tool": "agent_artifacts"');
      expect(browse.output).toContain('comparison-export.md');
      expect(browse.output).not.toContain('not-for-transcript');

      const show = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-show-artifact',
        fields: {
          artifactId: 'artifact-1',
          includeContent: 'yes',
          previewBytes: '48',
        },
      });
      expect(show.success).toBe(true);
      expect(show.output).toContain('"status": "executed_model_tool"');
      expect(show.output).toContain('"tool": "agent_artifacts"');
      const showPayload = JSON.parse(show.output ?? '{}') as { readonly output?: string | null };
      expect(showPayload.output).toContain('Saved comparison report');
      expect(showPayload.output).toContain('"apiKey": "<redacted>"');
      expect(showPayload.output).not.toContain('not-for-transcript');

      const unconfirmedExport = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'artifact-export-file',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifact to a workspace file.',
        fields: {
          artifactId: 'artifact-1',
          destinationPath: 'exports/comparison-export.md',
          confirm: 'no',
        },
      });
      expect(unconfirmedExport.success).toBe(true);
      expect(unconfirmedExport.output).toContain('"status": "not_confirmed"');

      const artifactExport = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-artifact-file',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifact to a workspace file.',
        fields: {
          artifactId: 'artifact-1',
          destinationPath: 'exports/comparison-export.md',
          confirm: 'yes',
        },
      });
      expect(artifactExport.success).toBe(true);
      expect(artifactExport.output).toContain('"tool": "agent_artifacts"');
      expect(artifactExport.output).toContain('Exported Agent artifact');
      expect(readFileSync(join(fixture.root, 'exports', 'comparison-export.md'), 'utf-8')).toContain('Saved comparison report');

      const unconfirmedPackage = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'artifact-export-package',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifacts to a workspace package directory.',
        fields: {
          artifactIds: 'artifact-1\nartifact-2',
          destinationPath: 'exports/comparison-package',
          confirm: 'no',
        },
      });
      expect(unconfirmedPackage.success).toBe(true);
      expect(unconfirmedPackage.output).toContain('"status": "not_confirmed"');

      const packageExport = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-artifact-package',
        confirm: true,
        explicitUserRequest: 'Export the reviewed comparison artifacts to a workspace package directory.',
        fields: {
          artifactIds: 'artifact-1\nartifact-2',
          destinationPath: 'exports/comparison-package',
          confirm: 'yes',
        },
      });
      expect(packageExport.success).toBe(true);
      expect(packageExport.output).toContain('"tool": "agent_artifacts"');
      expect(packageExport.output).toContain('Exported Agent artifact package');
      const packageRoot = join(fixture.root, 'exports', 'comparison-package');
      expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf-8')) as {
        readonly artifacts: Array<{ readonly id: string; readonly file: string; readonly metadata: Record<string, unknown> }>;
      };
      expect(manifest.artifacts.map((entry) => entry.id)).toEqual(['artifact-1', 'artifact-2']);
      expect(manifest.artifacts[1]?.metadata.secretToken).toBe('<redacted>');
      const packageFile = manifest.artifacts.find((entry) => entry.id === 'artifact-2')?.file;
      expect(readFileSync(join(packageRoot, packageFile ?? ''), 'utf-8')).toContain('"winner"');
      expect(packageExport.output).not.toContain('not-for-package');

      const unconfirmedPromotion = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'artifact-promote-knowledge',
        confirm: true,
        explicitUserRequest: 'Promote the reviewed comparison artifact into Agent Knowledge.',
        fields: {
          artifactId: 'artifact-1',
          confirm: 'no',
        },
      });
      expect(unconfirmedPromotion.success).toBe(true);
      expect(unconfirmedPromotion.output).toContain('"status": "not_confirmed"');
      expect(unconfirmedPromotion.output).toContain('artifact-promote-knowledge');

      const promotion = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-promote-artifact',
        confirm: true,
        explicitUserRequest: 'Promote the reviewed comparison artifact into Agent Knowledge.',
        fields: {
          artifactId: 'artifact-1',
          title: 'Reviewed comparison report',
          tags: 'artifact,reviewed',
          confirm: 'yes',
        },
      });
      expect(promotion.success).toBe(true);
      expect(promotion.output).toContain('"status": "executed_model_tool"');
      expect(promotion.output).toContain('"tool": "agent_knowledge_ingest"');
      expect(promotion.output).toContain('agent_knowledge_ingest executed');
    } finally {
      fixture.cleanup();
    }
  });

  test('runs confirmed research report workspace editor through agent_research_report', async () => {
    const artifacts = createHarnessArtifactStore();
    const fixture = makeFixture({ artifactStore: artifacts.store });
    try {
      fixture.toolRegistry.register(createAgentResearchReportTool(artifacts.store, ordinaryResearchOwner()));

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-save-report',
        confirm: true,
        explicitUserRequest: 'Save the reviewed local-model research report.',
        fields: {
          title: 'Local Model Options',
          question: 'Which local model route should we try?',
          summary: 'Ollama is easiest.',
          sources: 'Ollama docs | https://example.test/ollama?token=secret | high | Official docs.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');
      expect(unconfirmed.output).toContain('research-save-report');

      const saved = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-save-report',
        confirm: true,
        explicitUserRequest: 'Save the reviewed local-model research report.',
        fields: {
          title: 'Local Model Options',
          question: 'Which local model route should we try?',
          summary: 'Ollama is easiest.',
          reportMarkdown: 'Ollama is easiest [S1].',
          sources: 'Ollama docs | https://example.test/ollama?token=secret | high | Official docs.',
          findings: 'Use Ollama first.',
          gaps: 'Benchmark latency locally.',
          recommendations: 'Try Ollama before adding another provider.',
          methodology: 'Reviewed only source lines explicitly provided in the form.',
          confidence: 'medium',
          tags: 'research,local',
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_research_report"');
      expect(saved.output).toContain('Saved Agent research report artifact');
      expect(saved.output).toContain('visualReport markdown-visual-report-packet');
      expect(saved.output).not.toContain('Ollama is easiest [S1].');
      expect(saved.output).not.toContain('token=secret');

      const artifact = artifacts.store.list(1)[0];
      expect(artifact?.filename).toBe('local-model-options.md');
      expect(artifact?.metadata).toMatchObject({
        purpose: 'agent-research-report',
        source: 'agent-research-report',
        title: 'Local Model Options',
        question: 'Which local model route should we try?',
        sourceCount: 1,
        tags: ['research', 'local'],
        visualReport: {
          format: 'markdown-visual-report-packet',
          sourceCount: 1,
          findingCount: 1,
          gapCount: 1,
          recommendationCount: 1,
        },
      });
      expect(artifact?.metadata.sources).toEqual([{
        id: 'S1',
        title: 'Ollama docs',
        urlOmitted: true,
        credibility: 'high',
        note: 'Official docs.',
      }]);
      expect(JSON.stringify(artifact?.metadata)).not.toContain('token=secret');
    } finally {
      fixture.cleanup();
    }
  });

  test('runs confirmed research source workspace editor through agent_research_sources', async () => {
    const fixture = makeFixture();
    try {
      fixture.toolRegistry.register(createAgentResearchSourcesTool(fixture.paths));

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-add-source',
        confirm: true,
        explicitUserRequest: 'Add the reviewed Ollama source to the research queue.',
        fields: {
          question: 'Which local model route should we try?',
          title: 'Ollama docs',
          url: 'https://example.test/ollama?token=secret',
          summary: 'Official docs for the simplest local model setup.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');
      expect(unconfirmed.output).toContain('research-add-source');

      const saved = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-add-source',
        confirm: true,
        explicitUserRequest: 'Add the reviewed Ollama source to the research queue.',
        fields: {
          question: 'Which local model route should we try?',
          title: 'Ollama docs',
          url: 'https://example.test/ollama?token=secret',
          publisher: 'Ollama',
          publishedAt: '2026-06-01',
          summary: 'Official docs for the simplest local model setup.',
          evidence: 'Setup is local and minimal.',
          credibility: 'high',
          score: '92',
          tags: 'research,local',
          note: 'Official source for the first recommendation.',
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_research_sources"');
      expect(saved.output).toContain('Added Agent research source');
      expect(saved.output).not.toContain('token=secret');

      const source = AgentResearchSourceRegistry.fromShellPaths(fixture.paths).get('ollama-docs');
      expect(source?.question).toBe('Which local model route should we try?');
      expect(source?.url).toContain('token=%3Credacted%3E');
      expect(source?.url).not.toContain('token=secret');
      expect(source?.credibility).toBe('high');
      expect(source?.status).toBe('reviewed');
      expect(source?.score).toBe(92);
      expect(source?.tags).toEqual(['research', 'local']);
    } finally {
      fixture.cleanup();
    }
  });

  test('runs confirmed research run workspace editor through agent_research_runs', async () => {
    const fixture = makeFixture();
    try {
      fixture.toolRegistry.register(createAgentResearchRunsTool(fixture.paths));

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-start-run',
        confirm: true,
        explicitUserRequest: 'Create a visible competitor research run.',
        fields: {
          title: 'Competitor Research',
          question: 'Which competitor features should we match?',
          goal: 'Produce a sourced parity plan.',
          confirm: 'no',
        },
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');
      expect(unconfirmed.output).toContain('research-start-run');

      const saved = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'research-start-run',
        confirm: true,
        explicitUserRequest: 'Create a visible competitor research run.',
        fields: {
          title: 'Competitor Research',
          question: 'Which competitor features should we match?',
          goal: 'Produce a sourced parity plan.',
          plan: 'Inventory OpenClaw\nInventory Hermes',
          nextSteps: 'Capture official source ids',
          sourceIds: 'openclaw-docs,hermes-docs',
          note: 'Visible run state only.',
          confirm: 'yes',
        },
      });
      expect(saved.success).toBe(true);
      expect(saved.output).toContain('"status": "executed_model_tool"');
      expect(saved.output).toContain('"tool": "agent_research_runs"');
      expect(saved.output).toContain('Created Agent research run');

      const run = AgentResearchRunRegistry.fromShellPaths(fixture.paths).get('competitor-research');
      expect(run?.question).toBe('Which competitor features should we match?');
      expect(run?.goal).toBe('Produce a sourced parity plan.');
      expect(run?.status).toBe('planned');
      expect(run?.plan).toEqual(['Inventory OpenClaw', 'Inventory Hermes']);
      expect(run?.nextSteps).toEqual(['Capture official source ids']);
      expect(run?.sourceIds).toEqual(['openclaw-docs', 'hermes-docs']);
    } finally {
      fixture.cleanup();
    }
  });

  test('runs confirmed model compare workspace editor through agent_model_compare', async () => {
    const fixture = makeFixture();
    try {
      const modelCompareCalls: Record<string, unknown>[] = [];
      fixture.toolRegistry.register({
        definition: {
          name: 'agent_model_compare',
          description: 'agent_model_compare test tool',
          parameters: {
            type: 'object',
            properties: {},
            additionalProperties: true,
          },
        },
        execute: async (rawArgs: Record<string, unknown>) => {
          modelCompareCalls.push(rawArgs);
          return { success: true, output: 'agent_model_compare executed' };
        },
      });

      const unconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-run-compare',
        fields: {
          prompt: 'Write a release note for the document workflow.',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Compare release-note candidates.',
      });
      expect(unconfirmed.success).toBe(true);
      expect(unconfirmed.output).toContain('"status": "not_confirmed"');

      const executed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-run-compare',
        fields: {
          prompt: 'Write a release note for the document workflow.',
          modelRefs: 'openai:gpt-4.1, anthropic:claude-sonnet',
          rubric: 'Prefer concise and concrete.',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Compare release-note candidates.',
      });
      expect(executed.success).toBe(true);
      expect(executed.output).toContain('"status": "executed_model_tool"');
      expect(executed.output).toContain('"tool": "agent_model_compare"');
      expect(executed.output).toContain('agent_model_compare executed');

      const localBenchmark = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'account-run-local-model-benchmark',
        fields: {
          modelRefs: 'ollama:qwen2.5-coder:7b, openai:gpt-4.1',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Compare this local route before making it default.',
      });
      expect(localBenchmark.success).toBe(true);
      expect(localBenchmark.output).toContain('"status": "executed_model_tool"');
      expect(localBenchmark.output).toContain('"tool": "agent_model_compare"');
      expect(localBenchmark.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'run',
        benchmarkKind: 'local-model-route',
        taskType: 'local-model-route',
        modelRefs: ['ollama:qwen2.5-coder:7b', 'openai:gpt-4.1'],
        maxTokens: 1024,
        confirm: true,
      });
      expect(String(modelCompareCalls.at(-1)?.prompt)).toContain('Benchmark this local route');

      const review = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-review-compare',
        fields: {
          artifactId: 'artifact-1',
          reveal: 'no',
        },
      });
      expect(review.success).toBe(true);
      expect(review.output).toContain('"status": "executed_model_tool"');
      expect(review.output).toContain('"tool": "agent_model_compare"');
      expect(review.output).toContain('agent_model_compare executed');

      const sideBySide = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-review-compare',
        fields: {
          view: 'sideBySide',
          artifactId: 'artifact-2',
          relatedArtifactIds: 'artifact-doc',
          previewBytes: '600',
        },
      });
      expect(sideBySide.success).toBe(true);
      expect(sideBySide.output).toContain('"status": "executed_model_tool"');
      expect(sideBySide.output).toContain('"tool": "agent_model_compare"');
      expect(sideBySide.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'sideBySide',
        artifactId: 'artifact-2',
        relatedArtifactIds: ['artifact-doc'],
        previewBytes: 600,
      });

      const handoffDiff = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-review-compare',
        fields: {
          view: 'handoffDiff',
          leftArtifactId: 'artifact-7',
          rightArtifactId: 'artifact-10',
        },
      });
      expect(handoffDiff.success).toBe(true);
      expect(handoffDiff.output).toContain('"status": "executed_model_tool"');
      expect(handoffDiff.output).toContain('"tool": "agent_model_compare"');
      expect(handoffDiff.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoffDiff',
        leftArtifactId: 'artifact-7',
        rightArtifactId: 'artifact-10',
      });

      const explicitHandoffDiff = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-diff-handoffs',
        fields: {
          leftArtifactId: 'artifact-7',
          rightArtifactId: 'artifact-10',
          sectionId: 'related',
        },
      });
      expect(explicitHandoffDiff.success).toBe(true);
      expect(explicitHandoffDiff.output).toContain('"status": "executed_model_tool"');
      expect(explicitHandoffDiff.output).toContain('"tool": "agent_model_compare"');
      expect(explicitHandoffDiff.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoffDiff',
        leftArtifactId: 'artifact-7',
        rightArtifactId: 'artifact-10',
        sectionId: 'related',
      });

      const judgmentUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-judge-compare',
        fields: {
          artifactId: 'artifact-1',
          winnerBlindId: 'B',
          reasons: 'Candidate B was more concrete.',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Save comparison judgment.',
      });
      expect(judgmentUnconfirmed.success).toBe(true);
      expect(judgmentUnconfirmed.output).toContain('"status": "not_confirmed"');

      const judgment = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-judge-compare',
        fields: {
          artifactId: 'artifact-1',
          winnerBlindId: 'B',
          reasons: 'Candidate B was more concrete.',
          reveal: 'yes',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Save comparison judgment.',
      });
      expect(judgment.success).toBe(true);
      expect(judgment.output).toContain('"status": "executed_model_tool"');
      expect(judgment.output).toContain('"tool": "agent_model_compare"');
      expect(judgment.output).toContain('agent_model_compare executed');

      const analytics = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-compare-analytics',
        fields: {
          limit: '10',
          benchmarkKind: 'doc-draft',
          taskType: 'writing',
          documentId: 'doc_launch',
          includeReasons: 'yes',
        },
      });
      expect(analytics.success).toBe(true);
      expect(analytics.output).toContain('"status": "executed_model_tool"');
      expect(analytics.output).toContain('"tool": "agent_model_compare"');
      expect(analytics.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'analytics',
        limit: 10,
        benchmarkKind: 'doc-draft',
        taskType: 'writing',
        documentId: 'doc_launch',
        includeReasons: true,
      });

      const synthesis = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-compare-analytics',
        fields: {
          view: 'synthesis',
          limit: '5',
          benchmarkKind: 'doc-draft',
          taskType: 'writing',
          documentId: 'doc_launch',
          includeReasons: 'yes',
        },
      });
      expect(synthesis.success).toBe(true);
      expect(synthesis.output).toContain('"status": "executed_model_tool"');
      expect(synthesis.output).toContain('"tool": "agent_model_compare"');
      expect(synthesis.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'synthesis',
        limit: 5,
        benchmarkKind: 'doc-draft',
        taskType: 'writing',
        documentId: 'doc_launch',
        includeReasons: true,
      });

      const applyUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-apply-compare',
        fields: {
          artifactId: 'artifact-2',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Apply comparison winner.',
      });
      expect(applyUnconfirmed.success).toBe(true);
      expect(applyUnconfirmed.output).toContain('"status": "not_confirmed"');

      const apply = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-apply-compare',
        fields: {
          artifactId: 'artifact-2',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Apply comparison winner.',
      });
      expect(apply.success).toBe(true);
      expect(apply.output).toContain('"status": "executed_model_tool"');
      expect(apply.output).toContain('"tool": "agent_model_compare"');
      expect(apply.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'apply',
        artifactId: 'artifact-2',
        confirm: true,
      });

      const routeDecisionUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-record-route-decision',
        fields: {
          artifactId: 'artifact-2',
          decision: 'left-unchanged',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Leave comparison route unchanged.',
      });
      expect(routeDecisionUnconfirmed.success).toBe(true);
      expect(routeDecisionUnconfirmed.output).toContain('"status": "not_confirmed"');

      const routeDecision = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-record-route-decision',
        fields: {
          artifactId: 'artifact-2',
          decision: 'left-unchanged',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Leave comparison route unchanged.',
      });
      expect(routeDecision.success).toBe(true);
      expect(routeDecision.output).toContain('"status": "executed_model_tool"');
      expect(routeDecision.output).toContain('"tool": "agent_model_compare"');
      expect(routeDecision.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'routeDecision',
        artifactId: 'artifact-2',
        decision: 'left-unchanged',
        confirm: true,
      });

      const exportUnconfirmed = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          artifactId: 'artifact-1',
          confirm: 'no',
        },
        confirm: true,
        explicitUserRequest: 'Export comparison report.',
      });
      expect(exportUnconfirmed.success).toBe(true);
      expect(exportUnconfirmed.output).toContain('"status": "not_confirmed"');

      const exportReport = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          artifactId: 'artifact-1',
          reveal: 'yes',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Export comparison report.',
      });
      expect(exportReport.success).toBe(true);
      expect(exportReport.output).toContain('"status": "executed_model_tool"');
      expect(exportReport.output).toContain('"tool": "agent_model_compare"');
      expect(exportReport.output).toContain('agent_model_compare executed');

      const handoff = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          reportKind: 'handoff',
          artifactId: 'artifact-2',
          relatedArtifactIds: 'artifact-doc, artifact-package',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Create a reviewer handoff for this comparison.',
      });
      expect(handoff.success).toBe(true);
      expect(handoff.output).toContain('"status": "executed_model_tool"');
      expect(handoff.output).toContain('"tool": "agent_model_compare"');
      expect(handoff.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoff',
        artifactId: 'artifact-2',
        relatedArtifactIds: ['artifact-doc', 'artifact-package'],
        confirm: true,
      });

      const archive = await fixture.tool.execute({
        mode: 'run_workspace_action',
        actionId: 'document-export-compare',
        fields: {
          reportKind: 'archive',
          artifactId: 'artifact-7',
          confirm: 'yes',
        },
        confirm: true,
        explicitUserRequest: 'Archive a reviewer handoff for this comparison.',
      });
      expect(archive.success).toBe(true);
      expect(archive.output).toContain('"status": "executed_model_tool"');
      expect(archive.output).toContain('"tool": "agent_model_compare"');
      expect(archive.output).toContain('agent_model_compare executed');
      expect(modelCompareCalls.at(-1)).toMatchObject({
        mode: 'handoffArchive',
        artifactId: 'artifact-7',
        confirm: true,
      });
    } finally {
      fixture.cleanup();
    }
  });

  test('gates setting mutations and allows daemon setup settings through confirmed harness routes', async () => {
    const fixture = makeFixture();
    try {
      const missingConfirmation = await fixture.tool.execute({
        mode: 'set_setting',
        key: 'provider.model',
        value: 'openai:gpt-4.1',
        explicitUserRequest: 'Use this model.',
      });
      expect(missingConfirmation.success).toBe(false);
      expect(missingConfirmation.error).toContain('confirm:true');

      const set = await fixture.tool.execute({
        mode: 'set_setting',
        key: 'provider.model',
        value: 'openai:gpt-4.1',
        confirm: true,
        explicitUserRequest: 'Use this model.',
      });
      expect(set.success).toBe(true);
      expect(fixture.configManager.get('provider.model')).toBe('openai:gpt-4.1');

      const serviceSetting = await fixture.tool.execute({
        mode: 'set_setting',
        key: 'service.enabled',
        value: true,
        confirm: true,
        explicitUserRequest: 'Turn on the host service.',
      });
      expect(serviceSetting.success).toBe(true);
      expect(fixture.configManager.get('service.enabled')).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('resolves settings by key, target, and query without guessing ambiguous matches', async () => {
    const fixture = makeFixture();
    try {
      const summary = await fixture.tool.execute({ mode: 'summary', includeParameters: true });
      expect(summary.success, summary.error).toBe(true);
      const summaryJson = JSON.parse(summary.output ?? '{}') as { readonly modelAccess?: { readonly settings?: string } };
      expect(summaryJson.modelAccess?.settings).toContain('category');
      expect(summaryJson.modelAccess?.settings).toContain('prefix');
      expect(summaryJson.modelAccess?.settings).toContain('includeHidden:true');

      const defaultSettings = await fixture.tool.execute({ mode: 'settings' });
      expect(defaultSettings.success).toBe(true);
      const defaultPayload = JSON.parse(defaultSettings.output!) as {
        readonly settings: readonly { readonly key: string }[];
        readonly returned: number;
        readonly total: number;
        readonly note?: string;
      };
      const visibleSettingKeys = CONFIG_SCHEMA
        .filter((setting) => !isAgentHiddenSettingKey(setting.key))
        .map((setting) => setting.key)
        .sort();
      expect(defaultPayload.returned).toBe(visibleSettingKeys.length);
      expect(defaultPayload.total).toBe(visibleSettingKeys.length);
      expect(defaultPayload.settings.map((setting) => setting.key).sort()).toEqual(visibleSettingKeys);
      // A complete listing must not describe itself as partial.
      expect(defaultPayload.note).toBeUndefined();

      // A page cut short by `limit` says so in words, not only in two numbers
      // the reader has to notice and compare.
      const cappedSettings = await fixture.tool.execute({ mode: 'settings', limit: 3 });
      expect(cappedSettings.success).toBe(true);
      const cappedPayload = JSON.parse(cappedSettings.output!) as {
        readonly settings: readonly { readonly key: string }[];
        readonly returned: number;
        readonly total: number;
        readonly note?: string;
      };
      expect(cappedPayload.returned).toBe(3);
      expect(cappedPayload.total).toBe(visibleSettingKeys.length);
      expect(cappedPayload.note).toContain(`Showing 3 of ${visibleSettingKeys.length} settings`);
      expect(cappedPayload.note).toContain('not the full catalog');

      const allSettings = await fixture.tool.execute({ mode: 'settings', includeHidden: true });
      expect(allSettings.success).toBe(true);
      const allPayload = JSON.parse(allSettings.output!) as {
        readonly settings: readonly { readonly key: string; readonly visibleInWorkspace: boolean }[];
        readonly returned: number;
        readonly total: number;
      };
      expect(allPayload.returned).toBe(CONFIG_SCHEMA.length);
      expect(allPayload.total).toBe(CONFIG_SCHEMA.length);
      expect(allPayload.settings.filter((setting) => !setting.visibleInWorkspace).map(setting => setting.key).sort())
        .toEqual(CONFIG_SCHEMA.filter(setting => isAgentHiddenSettingKey(setting.key)).map(setting => setting.key).sort());

      const filteredSettings = await fixture.tool.execute({
        mode: 'settings',
        category: 'provider',
        prefix: 'provider.',
        query: 'reasoning',
        limit: 5,
      });
      expect(filteredSettings.success).toBe(true);
      const filteredPayload = JSON.parse(filteredSettings.output!) as {
        readonly settings: readonly { readonly key: string; readonly modelRoute?: string; readonly writable?: boolean }[];
        readonly returned: number;
      };
      expectCompactSummaryFields(filteredPayload);
      expect(filteredPayload.returned).toBeGreaterThan(0);
      expect(filteredPayload.settings.map((setting) => setting.key)).toContain('provider.reasoningEffort');
      expect(filteredPayload.settings.filter((setting) => !setting.key.startsWith('provider.'))).toEqual([]);
      expect(filteredPayload.settings.filter((setting) => (
        setting.writable !== true
        || !String(setting.modelRoute).startsWith('settings set|reset key:')
      ))).toEqual([]);

      const byTarget = await fixture.tool.execute({
        mode: 'get_setting',
        target: 'PROVIDER.MODEL',
      });
      expect(byTarget.success).toBe(true);
      const targetSetting = JSON.parse(byTarget.output!);
      expect(targetSetting.key).toBe('provider.model');
      expect(targetSetting.modelRoute).toBe('settings set|reset key:provider.model');
      expect(targetSetting.lookup).toEqual({
        source: 'target',
        input: 'PROVIDER.MODEL',
        resolvedBy: 'case-insensitive-key',
      });

      const byQuery = await fixture.tool.execute({
        mode: 'get_setting',
        query: 'reasoning',
        prefix: 'provider.reasoningEffort',
      });
      expect(byQuery.success).toBe(true);
      const querySetting = JSON.parse(byQuery.output!);
      expect(querySetting.key).toBe('provider.reasoningEffort');
      expect(querySetting.modelRoute).toBe('settings set|reset key:provider.reasoningEffort');
      expect(querySetting.lookup).toEqual({
        source: 'query',
        input: 'reasoning',
        resolvedBy: 'search',
      });

      const setByQuery = await fixture.tool.execute({
        mode: 'set_setting',
        query: 'reasoning',
        prefix: 'provider.reasoningEffort',
        value: 'high',
        confirm: true,
        explicitUserRequest: 'Use high reasoning effort.',
      });
      expect(setByQuery.success).toBe(true);
      expect(fixture.configManager.get('provider.reasoningEffort')).toBe('high');
      const setResult = JSON.parse(setByQuery.output!);
      expect(setResult.key).toBe('provider.reasoningEffort');
      expect(setResult.lookup.resolvedBy).toBe('search');

      const resetByTarget = await fixture.tool.execute({
        mode: 'reset_setting',
        target: 'PROVIDER.REASONINGEFFORT',
        confirm: true,
        explicitUserRequest: 'Reset reasoning effort.',
      });
      expect(resetByTarget.success).toBe(true);
      expect(fixture.configManager.get('provider.reasoningEffort')).not.toBe('high');
      const resetResult = JSON.parse(resetByTarget.output!);
      expect(resetResult.key).toBe('provider.reasoningEffort');
      expect(resetResult.lookup.resolvedBy).toBe('case-insensitive-key');

      const ambiguous = await fixture.tool.execute({
        mode: 'get_setting',
        query: 'provider',
      });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.error).toContain('Ambiguous setting provider');
      expect(ambiguous.error).toContain('provider.model');
      expect(ambiguous.error).toContain('modelRoute');
    } finally {
      fixture.cleanup();
    }
  });

  test('persists secret-backed setting values through the secret manager and redacts output', async () => {
    const fixture = makeFixture();
    try {
      const result = await fixture.tool.execute({
        mode: 'set_setting',
        key: 'surfaces.slack.botToken',
        value: 'xoxb-secret-value',
        confirm: true,
        explicitUserRequest: 'Set the Slack bot token.',
      });

      expect(result.success, result.error).toBe(true);
      expect(result.output).toContain('<secret-ref>');
      expect(result.output).not.toContain('xoxb-secret-value');
      expect(fixture.configManager.get('surfaces.slack.botToken')).toContain('goodvibes://secrets/');
      expect(await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe('xoxb-secret-value');
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects raw secret-backed setting values when secret storage is unavailable', async () => {
    const fixture = makeFixture({ secrets: false });
    try {
      const result = await fixture.tool.execute({
        mode: 'set_setting',
        key: 'surfaces.slack.botToken',
        value: 'xoxb-secret-value',
        confirm: true,
        explicitUserRequest: 'Set the Slack bot token.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('secrets manager is unavailable');
      expect(fixture.configManager.get('surfaces.slack.botToken')).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  test('resets secret-backed settings only when stored secret deletion can run', async () => {
    const fixture = makeFixture();
    try {
      const key = buildGoodVibesSecretKey('surfaces.slack.botToken');
      await fixture.secretsManager?.set(key, 'xoxb-secret-value', { scope: 'user' });
      fixture.configManager.setDynamic('surfaces.slack.botToken', buildGoodVibesSecretRef(key));

      const result = await fixture.tool.execute({
        mode: 'reset_setting',
        key: 'surfaces.slack.botToken',
        confirm: true,
        explicitUserRequest: 'Reset the Slack bot token.',
      });

      expect(result.success, result.error).toBe(true);
      expect(fixture.configManager.get('surfaces.slack.botToken')).toBe('');
      expect(await fixture.secretsManager?.get(key)).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects reset of secret-backed refs when secret deletion is unavailable', async () => {
    const fixture = makeFixture({ secrets: false });
    try {
      const key = buildGoodVibesSecretKey('surfaces.slack.botToken');
      const ref = buildGoodVibesSecretRef(key);
      fixture.configManager.setDynamic('surfaces.slack.botToken', ref);

      const result = await fixture.tool.execute({
        mode: 'reset_setting',
        key: 'surfaces.slack.botToken',
        confirm: true,
        explicitUserRequest: 'Reset the Slack bot token.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('secrets manager is unavailable');
      expect(fixture.configManager.get('surfaces.slack.botToken')).toBe(ref);
    } finally {
      fixture.cleanup();
    }
  });

  test('does not echo raw secret values when invoking settings through run_command', async () => {
    const fixture = makeFixture();
    try {
      registerOperatorRuntimeCommands(fixture.commandRegistry);

      const result = await fixture.tool.execute({
        mode: 'run_command',
        command: '/settings set surfaces.slack.botToken xoxb-secret-value --yes',
        confirm: true,
        explicitUserRequest: 'Set the Slack bot token.',
      });

      expect(result.success, result.error).toBe(true);
      expect(result.output).toContain('Command /settings completed.');
      expect(result.output).toContain('<secret-ref>');
      expect(result.output).not.toContain('xoxb-secret-value');
      expect(await fixture.secretsManager?.get(buildGoodVibesSecretKey('surfaces.slack.botToken'))).toBe('xoxb-secret-value');
    } finally {
      fixture.cleanup();
    }
  });

  test('model_routing cookbook recipes include hardwareFit annotation for known stacks', async () => {
    const fixture = makeFixture();
    try {
      const routing = await executeHarnessJson<{
        readonly localCookbook: {
          readonly recipes: readonly {
            readonly id: string;
            readonly hardwareFit?: string;
          }[];
        };
      }>(fixture, { mode: 'model_routing', includeParameters: true });
      const recipes = routing.localCookbook.recipes;
      expect(recipes.length).toBeGreaterThan(0);
      // Every recipe with a known stack (ollama, llama-cpp, vllm) must carry a
      // hardwareFit string when the hardware verdict is deterministic. When the
      // machine returns 'unknown' (null totalRamBytes and no GPU), fitVerdictLabel
      // returns '' and hardwareFit is absent, that is tolerated here.
      const knownStackIds = new Set(['ollama', 'llama-cpp', 'vllm']);
      for (const recipe of recipes) {
        if (knownStackIds.has(recipe.id)) {
          // Either absent (unknown hardware verdict) or a non-empty string.
          if (recipe.hardwareFit !== undefined) {
            expect(typeof recipe.hardwareFit).toBe('string');
            expect((recipe.hardwareFit as string).length).toBeGreaterThan(0);
          }
        }
      }
      // The openai-compatible-local stack has no stable size estimate; hardwareFit is absent.
      const generic = recipes.find((r) => r.id === 'openai-compatible-local');
      expect(generic?.hardwareFit).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });
});

// ── Catalog pages never go silent (empty list + large total) ─────────────────
//
// `workspace action:"actions"` answered {"actions":[],"returned":0,"total":463}:
// hundreds of entries reported to exist, none named, and no echo of the filter
// that excluded them. These pin that every catalog echoes its applied filters
// and explains an empty page, and that an UNQUALIFIED call still returns the
// full catalog, the three modes below had no unqualified-call coverage at all.

interface CatalogPage {
  readonly returned: number;
  readonly total: number;
  readonly note?: string;
  readonly appliedFilters?: Record<string, string>;
}

describe('agent_harness catalogs: an empty page states its cause', () => {
  test('an unqualified call returns the whole catalog for every discovery mode', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const cases: ReadonlyArray<[mode: string, key: string]> = [
        ['tools', 'tools'],
        ['ui_surfaces', 'surfaces'],
        ['cli_commands', 'commands'],
        ['commands', 'commands'],
        ['workspace_actions', 'actions'],
        ['modes', 'modes'],
      ];

      for (const [mode, key] of cases) {
        const page = await executeHarnessJson<CatalogPage & Record<string, unknown[]>>(fixture, { mode, limit: 500 });
        expect(page.total).toBeGreaterThan(0);
        expect(page.returned).toBeGreaterThan(0);
        expect((page[key] ?? []).length).toBe(page.returned);
        // Nothing was filtered, so nothing is echoed and no note is needed.
        expect(page.appliedFilters).toBeUndefined();
        expect(page.note).toBeUndefined();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('a filter that matches nothing is named back to the caller', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const cases: ReadonlyArray<[mode: string, filter: Record<string, string>, echoed: string]> = [
        ['workspace_actions', { category: 'actions' }, 'category="actions"'],
        ['tools', { query: 'zzz-no-such-tool' }, 'query="zzz-no-such-tool"'],
        ['ui_surfaces', { query: 'zzz-no-such-surface' }, 'query="zzz-no-such-surface"'],
        ['cli_commands', { query: 'zzz-no-such-cli' }, 'query="zzz-no-such-cli"'],
        ['commands', { query: 'zzz-no-such-command' }, 'query="zzz-no-such-command"'],
      ];

      for (const [mode, filter, echoed] of cases) {
        const page = await executeHarnessJson<CatalogPage>(fixture, { mode, ...filter });
        expect(page.returned).toBe(0);
        expect(page.total).toBeGreaterThan(0);
        expect(page.appliedFilters).toMatchObject(filter);
        expect(page.note).toBeDefined();
        expect(page.note).toContain(echoed);
        expect(page.note).toContain(String(page.total));
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('the workspace tool surfaces the same explanation through its actions route', async () => {
    const fixture = makeFixture({ builtinCommands: true });
    try {
      const workspaceTool = createAgentWorkspaceTool({
        harnessTool: fixture.tool,
        commandRegistry: fixture.commandRegistry,
        commandContext: fixture.context,
        toolRegistry: fixture.toolRegistry,
      });
      const result = await workspaceTool.execute({ action: 'actions', category: 'actions' });
      expect(result.success, result.error).toBe(true);
      const page = JSON.parse(result.output ?? '{}') as CatalogPage;
      expect(page.returned).toBe(0);
      expect(page.total).toBeGreaterThan(0);
      expect(page.note).toContain('category="actions"');
    } finally {
      fixture.cleanup();
    }
  });
});
