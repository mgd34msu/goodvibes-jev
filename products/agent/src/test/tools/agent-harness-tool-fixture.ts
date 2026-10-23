import { VoiceProviderRegistry, VoiceService } from '@goodvibes-jev/engine/sdk/platform/voice';
import { captureCatalogMethods } from '../../tools/agent-harness-catalog-ranking.ts';
import { ordinaryResearchOwner } from '../helpers/research-screening.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { buildTestModelDefinition } from '../helpers/test-managers.ts';
import type { ModelFacts, ModelTierStore, TierRecord } from '@goodvibes-jev/engine/sdk/platform/routing';
import { autonomyIntake } from '@goodvibes-jev/engine/sdk/platform/routing';
import { getOperatorContract } from '@goodvibes-jev/engine/sdk/contracts';
import { expect, test } from 'bun:test';
import { choice, noul, score, type JudgmentPort, type Question, type JsonValue } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { securityPort } from '../helpers/security-readings.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ArtifactStore, type ArtifactCreateInput, type ArtifactDescriptor, type ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { ProcessManager, ToolRegistry, learningCuratorScore, learningProposalTarget, learningDuplicateAlignment, learningSurvivorSelection, learningSurvivorEquivalence, memoryClass } from '@goodvibes-jev/engine/sdk/platform/tools';
import { PermissionManager, createPermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { FileUndoManager, MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore, type MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { ConfigManager } from '../../config/index.ts';
import { SubscriptionManager, ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { SecretsManager } from '../../config/secrets.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { KeybindingsManager } from '../../input/keybindings.ts';
import { createAgentHarnessTool, registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { registerAgentTerminalProcessTools } from '../../tools/agent-terminal-process-tools.ts';
import { WorkPlanStore } from '@goodvibes-jev/engine/sdk/platform/workflow';
import type { AgentExecutionRecord } from '../../runtime/execution-ledger.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';


export type ShellPaths = ReturnType<typeof createShellPathService>;

export type HarnessOpenSelection = NonNullable<CommandContext['openSelection']>;

export interface HarnessFixture {
  readonly root: string;
  readonly paths: ShellPaths;
  readonly commandRegistry: CommandRegistry;
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager | null;
  readonly keybindingsManager: KeybindingsManager;
  readonly toolRegistry: ToolRegistry;
  readonly permissionManager: PermissionManager;
  readonly processManager: ProcessManager;
  readonly tool: ReturnType<typeof createAgentHarnessTool>;
  readonly admittedTool: Tool;
  readonly executeAdmittedCall: (id: string, name: string, args: Record<string, unknown>, options?: Parameters<Tool['execute']>[1]) => ReturnType<Tool['execute']>;
  readonly context: CommandContext;
  readonly printed: string[];
  readonly openedSurfaces: Array<{ readonly id: string; readonly detail?: string; readonly result?: boolean }>;
  readonly openedSelections: Array<{ readonly title: string; readonly itemIds: readonly string[]; readonly preSelectId?: string }>;
  readonly executionRecords: AgentExecutionRecord[];
  readonly cleanup: () => void;
}

export function makeShellPaths(): { readonly root: string; readonly paths: ShellPaths; readonly cleanup: () => void } {
  const root = makeProjectTempDir('goodvibes-agent-harness-tool');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  return {
    root,
    paths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function makeConfig(paths: ShellPaths): ConfigManager {
  return new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT),
    workingDir: paths.workingDirectory,
    homeDir: paths.homeDirectory,
  });
}

export function createHarnessArtifactStore(clock: () => number = () => Date.now()) {
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
        sha256: createHash('sha256').update(buffer).digest('hex'),
        createdAt: clock() + records.length,
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

export function makeFixture(options: {
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
  // Keep this native credential owner inside its fixture. Ancestor discovery
  // would otherwise bind missing stores under shared test directories, whose
  // concurrent changes correctly retire the native absence receipts.
  const credentialRoot = join(root, 'credential-stores');
  mkdirSync(credentialRoot);
  if (options.controlPlaneEnabled !== undefined) configManager.set('controlPlane.enabled', options.controlPlaneEnabled);
  if (options.controlPlanePort !== undefined) configManager.set('controlPlane.port', options.controlPlanePort);
  const secretsManager = options.secrets === false
    ? null
    : new SecretsManager({ projectRoot: root, globalHome: root, configManager,
      keyFilePath: join(credentialRoot, 'secrets.key'),
      secureProjectFilePath: join(credentialRoot, 'project.enc'),
      secureUserFilePath: join(credentialRoot, 'user.enc'),
      secureDaemonFilePath: join(credentialRoot, 'daemon.enc'),
      plaintextProjectFilePath: join(credentialRoot, 'project.json'),
      plaintextUserFilePath: join(credentialRoot, 'user.json'),
      plaintextDaemonFilePath: join(credentialRoot, 'daemon.json'),
    });
  const keybindingsManager = new KeybindingsManager({
    configPath: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'keybindings.json'),
  });
  const reader = createPermissionConfigReader(configManager);
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const toolRegistry = new ToolRegistry(manager);
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

  const subscriptionManager = new SubscriptionManager(join(root, GOODVIBES_AGENT_SURFACE_ROOT, 'subscriptions.json'));
  const serviceRegistry = secretsManager ? new ServiceRegistry(join(root, GOODVIBES_AGENT_SURFACE_ROOT, 'services.json'), { secretsManager, subscriptionManager }) : undefined;
  const voiceProviderRegistry = new VoiceProviderRegistry();
  for (const [id, label, streaming] of [['stream-voice', 'Streaming Voice', true], ['non-stream-voice', 'Non Streaming Voice', false]] as const) {
    voiceProviderRegistry.register({ id, label, capabilities: streaming ? ['tts-stream', 'voice-list'] : ['voice-list'], billing: 'none',
      listVoices: async () => [{ id: `${id}-voice-a`, label: 'Voice A', metadata: {} }, { id: `${id}-voice-b`, label: 'Voice B', metadata: {} }] });
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
      ...(serviceRegistry ? { serviceRegistry } : {}),
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
      subscriptionManager,
      voiceProviderRegistry,
      voiceService: new VoiceService(voiceProviderRegistry),
      ...(options.artifactStore ? { artifactStore: options.artifactStore } : {}),
      readModels: {},
      ...(secretsManager ? { secretsManager } : {}),
    },
    clients: {
      mcpApi: {
        captureToolCatalog() {
          const api = this;
          const assertCurrent = captureCatalogMethods(api, ['listServerSecurity', 'listAllTools', 'captureToolCatalog']);
          return { assertCurrent, listAllTools: async () => {
            assertCurrent(); const tools = await api.listAllTools(); assertCurrent(); return tools;
          } };
        },
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
        getMessageSnapshot: () => [], getTranscriptEventIndex: () => ({ events: [], groups: [] }),
      },
      sessionManager,
    },
    provider: {
      providerRegistry: {
        listModels: (() => { const records = [{ provider: 'openai', modelId: 'gpt-4.1', providerEnvVars: ['OPENAI_API_KEY'] }]; return () => records; })(),
        captureProviderCatalogIds() {
          const assertCurrent = captureCatalogMethods(this, ['listModels']);
          return { providerIds: ['openai'], catalogProviderIds: ['openai'], assertCurrent };
        },
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

  registerAgentHarnessTool(toolRegistry, commandRegistry, context);
  const tool = createAgentHarnessTool({ commandRegistry, commandContext: context, toolRegistry });
  registerAgentTerminalProcessTools(toolRegistry, context);
  let invocation = 0;
  const executeAdmittedCall: HarnessFixture['executeAdmittedCall'] = async (id, name, args, options) => {
    options?.signal?.throwIfAborted(); options?.assertCurrent?.();
    configManager.flushConfigFileChanges();
    const call = await toolRegistry.prepareCall(id, name, args, { signal: options?.signal });
    const admission = await manager.admitAutonomous(id, name, call.args, {
      sourceOf: () => ({ goal: 'Verify the exact Agent harness operation requested by this isolated test',
        criteria: ['Only modify temporary fixture files, stubbed service owners, and explicitly configured loopback hosts'] }),
      signal: options?.signal, schemaRevision: call.schemaRevision, preparedCall: { registry: toolRegistry, call },
    });
    expect(admission.result.approved).toBe(true);
    return toolRegistry.executePrepared(call, admission, options);
  };
  const admittedTool: Tool = { ...tool, execute(args, options) {
    return executeAdmittedCall(`harness-effect-fixture-${++invocation}`, tool.definition.name, args, options);
  } };

  return {
    root,
    paths,
    commandRegistry,
    configManager,
    secretsManager,
    keybindingsManager,
    toolRegistry,
    permissionManager: manager,
    processManager,
    tool,
    admittedTool,
    executeAdmittedCall,
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

export async function createMemoryRegistry(paths: ShellPaths, configManager: ConfigManager): Promise<MemoryRegistry> {
  const embeddingRegistry = new MemoryEmbeddingProviderRegistry({ configManager });
  const store = new MemoryStore(paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT, 'memory.sqlite'), { embeddingRegistry });
  await store.init();
  return new MemoryRegistry(store);
}

export async function refusePreparedHarnessSetting(fixture: HarnessFixture, id: string, args: Record<string, unknown>,
  expectedEffect: Record<string, unknown>): Promise<void> {
  fixture.configManager.flushConfigFileChanges();
  const call = await fixture.toolRegistry.prepareCall(id, fixture.tool.definition.name, args);
  const owned = fixture.toolRegistry.readPreparedOwnedAdmissionEvidence(call);
  if (owned?.kind !== 'agent-settings') throw new Error('Expected native settings ownership.');
  expect<unknown>(owned.effect).toEqual({ ...expectedEffect,
    ...(typeof expectedEffect.previous === 'string' && expectedEffect.previous.startsWith('goodvibes://secrets/')
      ? { previous: { configured: true, redacted: true } } : {}) });
  const admission = await fixture.permissionManager.admitAutonomous(id, call.name, call.args, {
    sourceOf: () => ({ goal: 'Verify configured read-only settings behavior', criteria: ['The owned fixture setting stays unchanged'] }),
    schemaRevision: call.schemaRevision, preparedCall: { registry: fixture.toolRegistry, call },
  });
  expect(admission.result.approved).toBe(false);
  expect(admission.result.autonomousDecision).toBeUndefined();
  await expect(fixture.toolRegistry.executePrepared(call, admission)).rejects.toThrow('Autonomous admission does not authenticate this prepared tool call');
}

export function makeMemoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
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

export function attachMemoryApi(fixture: HarnessFixture, records: readonly MemoryRecord[] = [makeMemoryRecord()]): void {
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

export function registerStubTool(toolRegistry: ToolRegistry, name: string): Tool {
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
  return tool;
}

export function fakeChannelDeliveryRouter(requests: ChannelDeliveryRequest[]) {
  const strategies = [{ id: 'fake-channel', canHandle: () => true, deliver: async () => ({}) }];
  return {
    listStrategies: () => strategies,
    deliver: async (request: ChannelDeliveryRequest) => {
      requests.push(request);
      return 'harness-channel-response-1';
    },
  };
}

export function readAuthorizationHeader(headers: HeadersInit | undefined): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get('authorization');
  if (Array.isArray(headers)) {
    const entry = headers.find(([key]) => key.toLowerCase() === 'authorization');
    return entry ? String(entry[1]) : null;
  }
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
  return typeof value === 'string' ? value : null;
}

export function expectModelFacingText(output: string): void {
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

export function expectCompactSummaryFields(value: unknown, limit = 72): void {
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

export function expectCompactModelRoute(value: unknown): void {
  expect(typeof value).toBe('string');
  const route = String(value);
  expect(route.length).toBeGreaterThan(0);
  expect(route.length).toBeLessThanOrEqual(72);
}

export function expectRowsHaveCompactModelRoutes(rows: readonly Record<string, unknown>[]): void {
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows) expectCompactModelRoute(row.modelRoute);
}

export async function executeHarnessJson<T>(fixture: HarnessFixture, args: Record<string, unknown>): Promise<T> {
  const result = await fixture.admittedTool.execute(args);
  expect(result.success, `${String(args.mode)}: ${result.error}`).toBe(true);
  if (!result.success) throw new Error(result.error);
  return JSON.parse(result.output ?? '{}') as T;
}

export const CONNECTED_HOST_AUTH_ENV_KEYS = [
  'GOODVIBES_CONNECTED_HOST_TOKEN',
  'GOODVIBES_DAEMON_TOKEN',
] as const;

export const PROVIDER_AUTH_ENV_KEYS = [
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

export const LOCAL_MODEL_ENDPOINT_ENV_KEYS = [
  'OLLAMA_BASE_URL',
  'OLLAMA_HOST',
  'LM_STUDIO_BASE_URL',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENAI_COMPAT_BASE_URL',
  'VLLM_BASE_URL',
  'LLAMA_CPP_BASE_URL',
  'LITELLM_BASE_URL',
] as const;

export function clearEnvForTest(keys: readonly string[]): Map<string, string | undefined> {
  const previous = new Map<string, string | undefined>();
  for (const key of keys) {
    previous.set(key, process.env[key]);
    delete process.env[key];
  }
  return previous;
}

export function restoreEnvForTest(previous: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export async function withClearedEnv<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const previous = clearEnvForTest(keys);
  try {
    return await fn();
  } finally {
    restoreEnvForTest(previous);
  }
}

export async function withTcpListener<T>(fn: (port: number) => Promise<T>): Promise<T> {
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

export async function withPairedHost<T>(fn: (port: number) => Promise<T>): Promise<T> {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname !== '/api/control-plane/auth' || request.headers.get('authorization') !== 'Bearer fixture-connected-host-token') return new Response('unsupported fixture request', { status: 404 });
    return Response.json({ authenticated: true, authMode: 'shared-token', tokenPresent: true, authorizationHeaderPresent: true, sessionCookiePresent: false, principalId: 'synthetic-paired-owner', principalKind: 'token', admin: true, scopes: ['read:work-ledger', 'write:work-ledger'], roles: [] });
  } });
  try { return await withClearedEnv(CONNECTED_HOST_AUTH_ENV_KEYS, () => fn(server.port!)); } finally { server.stop(true); }
}

export function writeConnectedHostOperatorToken(fixture: HarnessFixture, token = 'fixture-connected-host-token'): void {
  writeFileSync(join(fixture.root, '.goodvibes', 'daemon', 'operator-tokens.json'), `${JSON.stringify({ token })}\n`, { mode: 0o600 });
}

export const emptyCatalogPicks: Readonly<Record<string, readonly string[]>> = {
  'zzz-no-such-tool': [], 'zzz-no-such-command': [], 'zzz-no-such-surface': [], 'zzz-no-such-cli': [],
};

export type HarnessLocalAnswer = { readonly kind: 'yes-no'; readonly probability: number }
  | { readonly kind: 'choice'; readonly choice: string };

export const harnessLocalAnswers = new Map<string, HarnessLocalAnswer>();

export function scriptHarnessLocalReading(name: string, state: unknown, answer: HarnessLocalAnswer): void {
  harnessLocalAnswers.set(JSON.stringify({ name, state }), answer);
}

export function createHarnessFixtureReadings(): JudgmentPort {
  harnessLocalAnswers.clear();
  const hostedModel = { provider: 'openai', modelId: 'gpt-4.1', providerEnvVars: ['OPENAI_API_KEY'] };
  scriptHarnessLocalReading('route', { evidence_kind: 'registry', registry_text: JSON.stringify(hostedModel), record: hostedModel },
    { kind: 'choice', choice: 'not-local' });
  const localModels = fakePort((name, question, state) => {
    const answer = harnessLocalAnswers.get(JSON.stringify({ name, state }));
    if (!answer) throw new Error('Unscripted complete local model source fixture.');
    if (answer.kind === 'yes-no' && question.type === 'noul') return noulAnswer(answer.probability);
    if (answer.kind === 'choice' && question.type === 'choice' && Object.hasOwn(question.criteria, answer.choice)) return choiceAnswer(question, answer.choice, 0.999);
    throw new Error('Local model fixture question does not match its authored answer schema.');
  });
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
  // Scripted P11 catalog readings keep discovery independent of local keyword matching.
  const catalogPicks: Readonly<Record<string, readonly string[]>> = {
    ...emptyCatalogPicks,
    settings: ['settings', 'get_setting', 'set_setting', 'reset_setting'],
    reasoning: ['provider.reasoningEffort'],
    provider: ['provider.model', 'provider.reasoningEffort'],
    'personal operations': ['personal_ops'],
    'ongoing-work': ['autonomy_intake'],
    'local shell execution': ['execution_posture'],
    'file edit undo recovery': ['file_recovery'],
    'execution history record': ['execution_history'],
    'blind model comparison documents uploads': ['document_ops'],
    'set setting': ['set_setting'],
    'automation.schedules.create': ['automation.schedules.create'],
    openai: ['openai'],
    picker: ['provider-picker', 'model-picker', 'panel-picker', 'file-picker', 'tts-provider-picker', 'tts-voice-picker', 'reasoning-effort-picker'],
    'streaming TTS provider picker': ['tts-provider-picker'],
    search: ['conversation-search', 'prompt-history-search'],
    'slash-command': ['slash-command-mode'],
    'command browser': ['command-browser'],
    'block action': ['block-actions'],
    operator: ['panel-picker', 'security-panel', 'knowledge-panel', 'subscription-panel'],
    'browser cockpit pwa': ['connected-browser-cockpit'],
    activity: ['process-monitor'],
    'live-output': ['live-tail'],
    'camera location': ['device-capability-map', 'camera-location-sensors'],
    'wake word': ['wake-and-speak'],
    'push to talk': ['push-to-talk'],
    'browser-control-research': ['browser-control-research'],
    'new competitor research request': [],
    'live-browser-research': ['live-browser-research'],
    'live verification': ['live-verification-json', 'live-verification-markdown'],
    'release-quality inventory': ['release-readiness-inventory-gate'],
    device: ['qr-pairing', 'manual-token-display', 'pairing-ui', 'connected-host-token-provisioning', 'connected-host-status', 'companion-capabilities', 'device-capability-map', 'whole-device-map'],
    voice: ['voice:openai', 'push-to-talk', 'voice-memo-transcription', 'spoken-responses', 'wake-and-speak'],
    custom: ['agent_custom_action', 'agent_custom_report'],
    'confirmed custom Agent action': ['agent_custom_action'],
    'send notice': ['agent_z_send_notice'],
    'target id': ['agent_custom_action'],
    'custom Agent': ['agent_custom_action', 'agent_custom_report'],
    knowledge: ['knowledge.map', 'knowledge.connector.doctor', 'knowledge.ingest.url'],
    'Test briefing command': ['brief'],
    'Agent-local memory records': ['memory', 'memory-review'],
    'not-a-command': [],
    local: ['route:local-model-cookbook', 'model:ollama-local:qwen2.5-coder:7b'],
    subagent: ['delegated-subagents'],
    auth: ['agent-alpha'],
    'bun test': ['call-shell'],
    'take a screenshot of the dashboard': ['screenshot-observation'],
    'navigate browser to a logged-in page': ['browser-navigation'],
    'take screenshot of the browser page': ['screenshot-observation'],
    'take a browser screenshot': ['screenshot-observation'],
  };
  const personalOps = fakePort((_name, _question, rawState) => {
    const captured = rawState as unknown as { query: string | { query: string; contextJson: string }; candidate: { name: string; evidenceJson?: string } };
    if (typeof captured.query !== 'string' && (!captured.query || typeof captured.query.query !== 'string'
      || typeof captured.query.contextJson !== 'string' || Object.keys(captured.query).length !== 2))
      throw new Error('Missing complete authored catalog query context.');
    const state = { ...captured, query: typeof captured.query === 'string' ? captured.query : captured.query.query };
    if (state.query === 'cursor') {
      const evidence: unknown = JSON.parse(state.candidate.evidenceJson ?? '{}');
      if (!evidence || typeof evidence !== 'object' || !('source' in evidence)) throw new Error('Missing authored project context evidence.');
      return noulAnswer(evidence.source === '.cursor/rules/*.mdc' ? 0.999 : 0.001);
    }
    if (state.query === 'vibe') return noulAnswer(state.candidate.name.startsWith('vibe:') ? 0.95 : 0.01);
    if (state.query === 'provider-access') {
      const evidence: unknown = JSON.parse(state.candidate.evidenceJson ?? '{}');
      if (!evidence || typeof evidence !== 'object' || !('record' in evidence)
        || !evidence.record || typeof evidence.record !== 'object' || !('id' in evidence.record))
        throw new Error('Missing authored setup record evidence.');
      return noulAnswer(evidence.record.id === 'provider-access' ? 0.999 : 0.001);
    }
    if (state.query === 'memory posture' || state.query === 'memory create') {
      const evidence: unknown = JSON.parse(state.candidate.evidenceJson ?? '{}');
      if (!evidence || typeof evidence !== 'object' || !('record' in evidence)
        || !evidence.record || typeof evidence.record !== 'object' || !('id' in evidence.record))
        throw new Error('Missing authored memory workspace action evidence.');
      return noulAnswer(evidence.record.id === (state.query === 'memory posture' ? 'memory-posture' : 'memory-create') ? 0.999 : 0.001);
    }
    if (['How should GoodVibes Agent expose browser-backed research?', 'Which browser-backed research evidence should count for release?'].includes(state.query)) {
      const evidence: unknown = JSON.parse(state.candidate.evidenceJson ?? '{}');
      if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || !('question' in evidence)) throw new Error('Missing authored research question evidence');
      return noulAnswer(evidence.question === state.query ? 0.999 : 0.001);
    }
    if (['picker', 'search', 'slash-command', 'command browser', 'block action', 'operator', 'browser cockpit pwa', 'activity', 'live-output'].includes(state.query)) {
      const evidence: unknown = JSON.parse(state.candidate.evidenceJson ?? '{}');
      if (!learningObject(evidence) || !learningObject(evidence.record) || typeof evidence.record.id !== 'string'
        || !learningObject(evidence.context) || !learningObject(evidence.context.args) || evidence.context.args.query !== state.query)
        throw new Error('Missing complete authored native UI row and query context');
      return noulAnswer(catalogPicks[state.query]!.includes(evidence.record.id) ? 0.999 : 0.001);
    }
    const catalogPick = catalogPicks[state.query];
    if (catalogPick !== undefined) return noulAnswer(catalogPick.includes(state.candidate.name) ? 0.95 : 0.01);
    const pick = personalOpsPicks[state.query];
    if (pick === undefined) throw new Error(`Unscripted catalog fixture ${state.query}`);
    return noulAnswer(state.candidate.name === pick ? 0.95 : 0.01);
  });
  // These exact contracts are authored controls for the native discovery
  // composition. Other registered methods are explicit negative controls.
  const nativePersonalOpsIds = new Set(getOperatorContract().operator.methods.map(method => method.id));
  const fixtureNonPersonalOpsIds = new Set(['filesystem', 'mcp:filesystem:read_file']);
  const laneMembers: Readonly<Record<string, readonly string[]>> = {
    inbox: ['channels.inbox.list', 'email.inbox.list', 'email.inbox.read', 'email.draft.create', 'email.send',
      'email.inbound.status', 'email.expectation.list', 'email.expectation.open', 'email.expectation.cancel',
      'gmail-inbox', 'mcp:gmail-inbox:gmail.search_messages', 'mcp:gmail-inbox:gmail.get_thread', 'mcp:gmail-inbox:gmail.send_reply'],
    calendar: ['calendar.events.list', 'calendar.events.get', 'calendar.events.create', 'calendar.ics.import', 'calendar.ics.export',
      'caldav-agenda', 'mcp:caldav-agenda:caldav.list_events', 'mcp:caldav-agenda:caldav.update_event'],
    tasks: ['tasks.list', 'tasks.get', 'tasks.create', 'tasks.cancel', 'tasks.retry', 'tasks.status'],
    reminders: ['automation.schedules.create', 'automation.schedules.list', 'automation.schedules.delete',
      'automation.schedules.disable', 'automation.schedules.enable', 'automation.schedules.run'],
    approvals: ['approvals.approve', 'approvals.cancel', 'approvals.claim', 'approvals.deny', 'approvals.list', 'approvals.raise'],
    automation: ['automation.heartbeat.list', 'automation.heartbeat.run', 'automation.integration.snapshot',
      'automation.jobs.create', 'automation.jobs.delete', 'automation.jobs.disable', 'automation.jobs.enable',
      'automation.jobs.list', 'automation.jobs.run', 'automation.jobs.update',
      'automation.runs.cancel', 'automation.runs.get', 'automation.runs.list', 'automation.runs.retry',
      'automation.schedules.create', 'automation.schedules.delete', 'automation.schedules.disable',
      'automation.schedules.enable', 'automation.schedules.list', 'automation.schedules.run'],
    schedules: ['automation.schedules.create', 'automation.schedules.delete', 'automation.schedules.disable',
      'automation.schedules.enable', 'automation.schedules.list', 'automation.schedules.run'],
  };
  const connectorLanes: Readonly<Record<string, 'inbox' | 'calendar'>> = {
    'gmail.search_messages': 'inbox', 'gmail.get_thread': 'inbox', 'gmail.send_reply': 'inbox',
    'caldav.list_events': 'calendar', 'caldav.update_event': 'calendar',
  };
  const connectorFields: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    'gmail.search_messages': { query: 'query', limit: 'count', mailbox: 'mailbox', unreadOnly: 'include' },
    'gmail.get_thread': { threadId: 'record', includeAttachments: 'include' },
    'gmail.send_reply': { threadId: 'record', body: 'body', dryRun: 'preview' },
    'caldav.list_events': { start: 'start', end: 'end', calendarId: 'calendar' },
    'caldav.update_event': { eventId: 'record', title: 'subject', start: 'start', end: 'end' },
  };
  const personalOpsDiscovery = fakePort((name, question, state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected Personal Ops discovery control.');
    if (name === 'match' && question.type === 'noul' && typeof state.query === 'string'
      && state.candidate && typeof state.candidate === 'object' && !Array.isArray(state.candidate)
      && typeof state.candidate.name === 'string') {
      const members = laneMembers[state.query], id = state.candidate.name;
      if (!members || (!nativePersonalOpsIds.has(id) && !fixtureNonPersonalOpsIds.has(id)
        && !Object.values(laneMembers).some(entries => entries.includes(id)))) {
        throw new Error(`Unscripted exact lane-member control ${state.query}:${id}`);
      }
      return noulAnswer(members.includes(id) ? 0.999 : 0.001);
    }
    const contract = state.contract;
    const tool = typeof state.tool === 'string' ? state.tool
      : contract && typeof contract === 'object' && !Array.isArray(contract) && typeof contract.tool === 'string' ? contract.tool : undefined;
    if (!tool || !connectorLanes[tool]) throw new Error(`Unscripted connector contract ${String(tool)}`);
    if (name === 'lane' && question.type === 'choice') return choiceAnswer(question, connectorLanes[tool]!, 0.999);
    if (name === 'role' && question.type === 'choice' && typeof state.field === 'string') {
      const role = connectorFields[tool]?.[state.field];
      if (!role) throw new Error(`Unscripted connector field ${tool}:${state.field}`);
      return choiceAnswer(question, role, 0.999);
    }
    if (question.type === 'noul' && ['mutates', 'outward', 'secrets'].includes(name)) {
      const effect = tool === 'gmail.send_reply' || tool === 'caldav.update_event';
      return noulAnswer(effect && name !== 'secrets' ? 0.999 : 0.001);
    }
    throw new Error(`Unscripted Personal Ops discovery question ${name}`);
  });
  const lifetime = fakePort(() => noulAnswer(0.01));
  const readiness = fakePort((name, question) => question.type === 'score' ? scoreAnswer(question, name === 'memoryAdequacy' ? 2 : 3) : noulAnswer(0.95));
  const intake = fakePort((name, question, rawState) => {
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState) || typeof rawState.request !== 'string') throw new Error('Unexpected autonomy intake fixture.');
    const fixture = autonomyIntake.fixtures.find(entry => entry.state !== null && typeof entry.state === 'object' && !Array.isArray(entry.state) && entry.state.request === rawState.request);
    const expected = fixture && Object.entries(fixture.expect).find(([key]) => key === name)?.[1];
    if (question.type === 'choice' && typeof expected === 'string') return choiceAnswer(question, expected, 0.99);
    if (expected === 'yes' || expected === 'no') return noulAnswer(expected === 'yes' ? 0.99 : 0.01);
    throw new Error(`Unscripted autonomy intake fixture ${rawState.request}:${name}`);
  });
  const interactiveRuntime = fakePort((name, question, state) => {
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.record || typeof state.record !== 'object' || Array.isArray(state.record)) throw new Error('Missing authored runtime evidence');
    const record = state.record;
    const controls: Readonly<Record<string, readonly [string, string]>> = {
      'runtime-process-1': ['process-output', 'running'], 'pty-session-1': ['pty-session', 'ready'],
      'sudo-contract-1': ['sudo-mediation', 'ready'], 'browser-receipt-1': ['browser-desktop-receipt', 'completed'],
    };
    const expected = typeof record.id === 'string' ? controls[record.id] : undefined;
    if (!expected) throw new Error('Unscripted runtime record');
    expect(record.schemaStatus).toBe('certified');
    if (name === 'certified' && question.type === 'noul') return noulAnswer(0.999);
    if (name === 'kind' && question.type === 'choice') return choiceAnswer(question, expected[0], 0.999);
    if (name === 'status' && question.type === 'choice') return choiceAnswer(question, expected[1], 0.999);
    if (name === 'role' && question.type === 'choice' && typeof state.key === 'string') {
      const roles: Readonly<Record<string, string>> = { inspect: 'inspect', log: 'log', output: 'log', write: 'write', input: 'write', kill: 'close', close: 'close', resize: 'resize', credential: 'credential', execute: 'execute', receipt: 'receipt' };
      return choiceAnswer(question, roles[state.key] ?? 'none', 0.999);
    }
    throw new Error(`Unscripted runtime reading ${name}`);
  });
  const intakeSchedule = fakePort((name, question, state) => {
    const request = 'Remind me every 2 hours to check the deploy.';
    if (question.type === 'noul' && ['complete', 'timing', 'conditions'].includes(name)) {
      if (!state || typeof state !== 'object' || Array.isArray(state) || state.scheduleRequest !== request) throw new Error(`Unscripted intake schedule verification ${name}`);
      expect(state.proposedSchedule).toMatchObject({ description: 'Repeat every 2 hour of elapsed time.' });
      return noulAnswer(0.001);
    }
    const phrase = typeof state === 'string' ? state : state && typeof state === 'object' && !Array.isArray(state) ? state.phrase : undefined;
    if (phrase !== request) throw new Error(`Unscripted intake schedule source ${name}`);
    const choices: Readonly<Record<string, string>> = { format: 'natural', shape: 'interval', quantity: 'stated', unit: 'hour' };
    const selected = choices[name];
    if (question.type !== 'choice' || !selected) throw new Error(`Unscripted intake schedule reading ${name}`);
    return choiceAnswer(question, selected, 0.99);
  });
  const metadata = fakePort((_name, _question, rawState) => {
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState) || typeof rawState.query !== 'string'
      || !rawState.candidate || typeof rawState.candidate !== 'object' || Array.isArray(rawState.candidate) || typeof rawState.candidate.name !== 'string') {
      throw new Error('Unexpected metadata catalog fixture.');
    }
    const picks: Readonly<Record<string, readonly string[]>> = {
      knowledge: ['knowledge'], 'Call isolated Agent Knowledge routes': ['knowledge'], Agent: ['tui', 'knowledge'], 'zzz-no-such-cli': [],
      workspace: ['workspace-picker', 'workspace-close'], 'conversation search': ['search'], 'Toggle conversation search': ['search'], help: ['? / F1'],
      'runtime activity': ['F2'], 'shortcut reference': ['/shortcuts'],
    };
    const selected = picks[rawState.query];
    if (!selected) throw new Error(`Unscripted metadata catalog fixture ${rawState.query}`);
    return noulAnswer(selected.includes(rawState.candidate.name) ? 0.95 : 0.01);
  });
  const executionVerification = fakePort((name, question, state) => {
    if (name !== 'verification' || question.type !== 'noul' || !state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected execution verification fixture.');
    const id = state.callId ?? state.id;
    if (id === 'call-shell') return noulAnswer(0.999);
    if (id === 'call-edit') return noulAnswer(0.001);
    throw new Error(`Unscripted execution verification fixture ${String(id)}`);
  });
  const receiptStatus = fakePort((name, question, state) => {
    if (name !== 'status' || question.type !== 'choice' || !state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('Unexpected authored receipt-status fixture.');
    }
    const metadata = state.metadata;
    const status = metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata.status : undefined;
    const expected: Readonly<Record<string, string>> = { succeeded: 'succeeded', sent: 'succeeded', failed: 'failed',
      blocked: 'blocked', running: 'running', pending: 'running', queued: 'running' };
    return choiceAnswer(question, typeof status === 'string' ? expected[status] ?? 'other' : 'other', 0.999);
  });
  // Exact external-memory caller controls. No general provider word parser lives in this fixture.
  const memoryRoleChoices: Readonly<Record<string, string>> = { read: 'read', write: 'write', sync: 'sync', forget: 'forget', inspect: 'inspect', receipts: 'receipt' };
  const memorySemantic = fakePort((name, question, state) => {
    if (state === null || typeof state !== 'object' || Array.isArray(state)) throw new Error('Unexpected external-memory fixture state');
    if (name === 'role' || name === 'form') {
      const role = typeof state.field === 'string' ? memoryRoleChoices[state.field] : undefined;
      const operation = state.container === 'routes' || state.container === 'capabilities';
      if (question.type !== 'choice') throw new Error('Expected external-memory operation choice');
      return choiceAnswer(question, name === 'role' ? operation && role ? role : 'none'
        : operation && role ? state.container === 'routes' ? 'route' : 'flag' : 'none', 0.999);
    }
    if (name === 'state' && question.type === 'choice') return choiceAnswer(question, 'configured-secret-ref', 0.999);
    if (name === 'status' && question.type === 'choice') return choiceAnswer(question, 'available', 0.999);
    if (name === 'certified' && question.type === 'noul') {
      const record = state.record;
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Missing authored memory certification record');
      return noulAnswer(record.schemaVersion === 'goodvibes.external-memory.provider.v1' || record.schemaVersion === 'goodvibes.external-memory.receipt.v1' ? 0.999 : 0.001);
    }
    if (name === 'member' && question.type === 'noul') return noulAnswer(0.001);
    if (name === 'credential' && question.type === 'noul') return noulAnswer(0.001);
    if (name === 'pick' && question.type === 'choice') return choiceAnswer(question, '8', 0.999);
    if (question.type === 'noul' && /^fits_[0-8]$/.test(name)) return noulAnswer(name === 'fits_8' ? 0.999 : 0.001);
    throw new Error(`Unscripted external-memory caller question ${name}`);
  });
  const memoryCatalog = fakePort((name, _question, state) => {
    if (name !== 'match' || state === null || typeof state !== 'object' || Array.isArray(state)
      || state.query !== 'the Supermemory external-memory provider' || !state.candidate || typeof state.candidate !== 'object'
      || Array.isArray(state.candidate)) throw new Error('Unexpected authored memory-provider catalog request');
    return noulAnswer(state.candidate.name === 'external-memory:supermemory' ? 0.999 : 0.001);
  });
  const resultField = fakePort((name, question, state) => {
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!object(state) || !object(state.context) || !object(state.context.source) || typeof state.context.purpose !== 'string' || !Array.isArray(state.candidates))
      throw new Error('Unscripted Personal Ops result field fixture shape');
    const source = state.context.source, purpose = state.context.purpose;
    let key: string | undefined;
    if (purpose === 'primary returned personal record collection or its enclosing result object') {
      if (Array.isArray(source.content) && object(source.structuredContent) && Array.isArray(source.structuredContent.messages)
        && source.structuredContent.messages.length === 1 && object(source.structuredContent.messages[0])
        && source.structuredContent.messages[0].id === 'msg-1') key = 'structuredContent';
      else if (Array.isArray(source.messages) && object(source.messages[0]) && source.messages[0].id === 'msg-1') key = 'messages';
    } else if (source.id === 'msg-1' && source.subject === 'Quarterly planning') {
      const fields: Readonly<Record<string, string>> = { 'email message or thread identifier': 'id', 'email message subject': 'subject',
        'email message sender': 'from', 'message received time': 'receivedAt', 'message body or preview text': 'snippet' };
      key = fields[purpose];
    } else if (source.id === 'msg-1' && source.kind === 'inbox-message' && source.label === 'Quarterly planning') {
      const fields: Readonly<Record<string, string>> = { 'review record field serving one of: label, subject, title, summary': 'label',
        'review record field serving one of: kind': 'kind', 'review record field serving one of: id': 'id' };
      key = fields[purpose];
    }
    if (!key) throw new Error(`Unscripted Personal Ops result field purpose ${purpose}`);
    expect(state.candidates).toHaveLength(Object.keys(source).length);
    const candidates = state.candidates.map(candidate => {
      if (!object(candidate) || typeof candidate.id !== 'string' || !object(candidate.content) || typeof candidate.content.key !== 'string')
        throw new Error('Unscripted Personal Ops field candidate');
      expect(candidate.content.value).toEqual(source[candidate.content.key]);
      return { id: candidate.id, key: candidate.content.key };
    });
    const chosen = candidates.find(candidate => candidate.key === key)?.id;
    if (chosen === undefined) throw new Error('Missing authored Personal Ops field candidate');
    if (name === 'pick' && question.type === 'choice') return choiceAnswer(question, chosen, 0.999);
    if (question.type === 'noul' && candidates.some(candidate => name === `fits_${candidate.id}`)) return noulAnswer(name === `fits_${chosen}` ? 0.999 : 0.001);
    throw new Error(`Unscripted Personal Ops field question ${name}`);
  });
  const admission = fakePort((name, question) => {
    if (question.type === 'choice') {
      const choice = name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (!choice) throw new Error(`Unscripted harness admission choice ${name}`);
      return choiceAnswer(question, choice, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unscripted harness admission reading ${name}`);
  });
  // Ordinary catalog/record scripts explicitly answer the shared privacy
  // contracts. Focused containment suites exercise their positive readings.
  const fixtureCredentialFields = new Set(['token', 'password', 'secret', 'credential', 'apiKey', 'api_key', 'accessToken', 'access_token', 'refreshToken',
    'refresh_token', 'clientSecret', 'client_secret', 'privateKey', 'private_key', 'unlockPassphrase']);
  const privacy = fakePort((name, question, state) => {
    if (name === 'kind' && question.type === 'choice' && Object.hasOwn(question.criteria, 'owner_profile')
      && state && typeof state === 'object' && !Array.isArray(state) && typeof state.field === 'string') {
      return choiceAnswer(question, fixtureCredentialFields.has(state.field) ? 'secret' : 'other', 0.999);
    }
    if (question.type === 'noul' && ['lineHasCredential', 'spanIsCredential', 'credentialRemains', 'identifying'].includes(name)) {
      if ((name === 'lineHasCredential' || name === 'spanIsCredential') && state && typeof state === 'object'
        && !Array.isArray(state) && Array.isArray(state.parts)) {
        const protectedSpan = state.parts.some(part => part && typeof part === 'object' && !Array.isArray(part)
          && part.kind === 'span' && typeof part.field === 'string' && fixtureCredentialFields.has(part.field)
          && (name === 'lineHasCredential' || part.reference === state.target));
        return noulAnswer(protectedSpan ? 0.999 : 0.001);
      }
      return noulAnswer(0.001);
    }
    throw new Error(`Unscripted harness privacy fixture ${name}`);
  });
  const publisherFixtures: Readonly<Record<string, { readonly schema: boolean; readonly kind?: 'capture' | 'export' | 'closeout' | 'artifact' | 'other' }>> = {
    'query-private-source': { schema: true, kind: 'capture' },
    'query-native-workspace': { schema: true },
    'empty-native-workspace': { schema: false },
    'unowned-workspace': { schema: false },
    'capture-alpha-live': { schema: true, kind: 'capture' },
    'workspace-alpha': { schema: true },
    'remote-publisher-opposition': { schema: false, kind: 'capture' },
    'remote-publisher-paraphrase': { schema: true, kind: 'closeout' },
    'remote-publisher-missing-status': { schema: false, kind: 'other' },
  };
  const publisherField = (state: unknown, wanted: readonly string[]): string | undefined => {
    if (!Array.isArray(state)) throw new Error('Unexpected remote publisher field state');
    for (const field of state) {
      if (!field || typeof field !== 'object' || !Array.isArray(field.path) || field.path.length !== wanted.length
        || field.path.some((part: unknown, index: number) => part !== wanted[index])) continue;
      if (field.kind !== 'text' || !Array.isArray(field.parts)) throw new Error('Unexpected remote publisher field shape');
      return field.parts.map((part: JsonValue) => {
        if (!part || typeof part !== 'object' || Array.isArray(part) || part.kind !== 'text' || typeof part.text !== 'string')
          throw new Error('Unexpected remote publisher identity text');
        return part.text;
      }).join('');
    }
    return undefined;
  };
  const publisher = fakePort((name, question, state) => {
    const id = publisherField(state, ['record', 'id']) ?? publisherField(state, ['record', 'workspaceId']);
    const fixture = id === undefined ? undefined : publisherFixtures[id];
    if (!fixture) throw new Error('Unscripted remote publisher identity');
    if (name === 'certified_schema' && question.type === 'noul') return noulAnswer(fixture.schema ? 0.999 : 0.001);
    if (name === 'outcome_kind' && question.type === 'choice' && fixture.kind) return choiceAnswer(question, fixture.kind, 0.999);
    throw new Error(`Unscripted remote publisher question ${name}`);
  });
  const learningObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
  type LearningGrades = { readonly [K in keyof typeof learningCuratorScore.items]: number };
  type LearningControl = {
    readonly domain: string; readonly name: string; readonly nameField: 'name' | 'title' | 'summary';
    readonly text: string; readonly textField: 'body' | 'procedure' | 'steps' | 'detail' | 'notes' | 'note';
    readonly grades: LearningGrades; readonly target?: 'memory' | 'skill' | 'routine' | 'persona' | 'none';
    readonly memoryClass?: 'decision';
  };
  const ordinaryLearningGrades: LearningGrades = { usefulness: 3, freshness: 3, source_quality: 3, risk: 1, priority: 2, confidence: 3 };
  const limitedLearningGrades: LearningGrades = { usefulness: 2, freshness: 3, source_quality: 2, risk: 2, priority: 3, confidence: 2 };
  // Each entry is an exact authored native record from the existing prompt or curator scenario.
  const learningControls: readonly LearningControl[] = [
    { domain: 'memory', nameField: 'summary', name: 'Prefers concise briefings', textField: 'detail', text: 'Lead with status, then next action.', grades: ordinaryLearningGrades },
    { domain: 'memory', nameField: 'summary', name: 'Low confidence memory', textField: 'detail', text: 'Lead with status, then next action.', grades: limitedLearningGrades },
    { domain: 'memory', nameField: 'summary', name: 'Unreviewed memory', textField: 'detail', text: 'Lead with status, then next action.', grades: ordinaryLearningGrades },
    { domain: 'memory', nameField: 'summary', name: 'Use the private deployment checklist before release.', textField: 'detail', text: 'Checklist is useful but still needs review.', grades: limitedLearningGrades },
    { domain: 'memory', nameField: 'summary', name: 'Use the private deployment checklist before release.', textField: 'detail', text: 'Duplicate copy adds UX inventory and package verification context.', grades: ordinaryLearningGrades },
    { domain: 'persona', nameField: 'name', name: 'Reviewed prompt inspector', textField: 'body', text: 'Explain applied context before acting when context is ambiguous.', grades: ordinaryLearningGrades },
    { domain: 'persona', nameField: 'name', name: 'Fresh operator persona', textField: 'body', text: 'Prefer concise operational answers.', grades: ordinaryLearningGrades },
    { domain: 'persona', nameField: 'name', name: 'Reviewed release operator persona', textField: 'body', text: 'Keep release closeout concise and evidence-backed.', grades: ordinaryLearningGrades },
    { domain: 'skill', nameField: 'name', name: 'Prompt evidence skill', textField: 'procedure', text: 'List selected context records, then ask for confirmation before changes.', grades: ordinaryLearningGrades },
    { domain: 'skill', nameField: 'name', name: 'Blocked prompt skill', textField: 'procedure', text: 'Use an unavailable command.', grades: limitedLearningGrades },
    { domain: 'skill', nameField: 'name', name: 'Missing command skill', textField: 'procedure', text: 'Run the missing command and summarize results.', grades: limitedLearningGrades },
    { domain: 'skill', nameField: 'name', name: 'Missing command skill!', textField: 'procedure', text: 'Run package verification, check UX inventory, then summarize results.', grades: ordinaryLearningGrades },
    { domain: 'routine', nameField: 'name', name: 'Prompt closeout routine', textField: 'steps', text: 'Summarize applied context, suppressed context, and next review route.', grades: ordinaryLearningGrades },
    { domain: 'routine', nameField: 'name', name: 'Blocked prompt routine', textField: 'steps', text: 'Run unavailable setup before use.', grades: limitedLearningGrades },
    { domain: 'note', nameField: 'title', name: 'Reviewed source note', textField: 'body', text: 'Durable source note for later knowledge ingest.', grades: ordinaryLearningGrades, target: 'none' },
    { domain: 'note', nameField: 'title', name: 'Release checklist workflow', textField: 'body', text: 'Repeat before release: check package verification, review UX inventory, and summarize residual risks.', grades: ordinaryLearningGrades, target: 'routine' },
    { domain: 'note', nameField: 'title', name: 'Renderer decision memory', textField: 'body', text: 'Decision: keep the existing renderer as the Agent UI foundation.', grades: ordinaryLearningGrades, target: 'memory', memoryClass: 'decision' },
    { domain: 'work_plan', nameField: 'title', name: 'Release readiness workflow', textField: 'notes', text: 'Repeat before release: run package verification, check UX inventory, and summarize residual risks.', grades: ordinaryLearningGrades, target: 'routine' },
    { domain: 'work_plan', nameField: 'title', name: 'Renderer decision capture', textField: 'notes', text: 'Decision: use the existing renderer for the autonomous Agent harness.', grades: ordinaryLearningGrades, target: 'memory', memoryClass: 'decision' },
    { domain: 'research_run', nameField: 'title', name: 'Research report procedure', textField: 'note', text: 'Procedure: review source credibility, citation coverage, and report artifact before closing deep research.', grades: ordinaryLearningGrades, target: 'skill' },
    { domain: 'work_plan', nameField: 'title', name: 'Cancelled browser setup investigation', textField: 'notes', text: 'Agent dispatch receipt 2026-06-06T00:00:01.000Z; agent agent-beta; route agent { mode: "batch-spawn" }; cohort browser-work; request check browser setup', grades: ordinaryLearningGrades, target: 'none' },
    { domain: 'work_plan', nameField: 'title', name: 'Investigate auth flow and report user-facing risks', textField: 'notes', text: 'Agent dispatch receipt 2026-06-06T00:00:00.000Z; agent agent-alpha; route agent { mode: "spawn" }; cohort auth-work; request investigate auth risks', grades: ordinaryLearningGrades, target: 'none' },
    { domain: 'note', nameField: 'title', name: 'Follow-up queue', textField: 'body', text: 'Track pending replies, reminders, and handoffs here.', grades: ordinaryLearningGrades, target: 'none' },
  ];
  const sessionLearningControl: LearningControl = { domain: 'session', nameField: 'title', name: 'Release review lesson session', textField: 'body', text: 'Lesson: when asked to prepare release review, run typecheck, package verification, UX inventory, and summarize residual risks.', grades: ordinaryLearningGrades, target: 'skill' };
  const sessionPromotionControl: LearningControl = { domain: 'session', nameField: 'title', name: 'Auto-promote integration session', textField: 'body', text: 'Lesson: invoke learning_auto_promote after curator review to promote skill drafts autonomously.', grades: ordinaryLearningGrades, target: 'skill' };
  const learningControl = (value: unknown): LearningControl => {
    if (!learningObject(value)) throw new Error('Missing complete native learning fixture record');
    const native = learningObject(value.item) && learningObject(value.record) ? value.record : value;
    if (learningObject(native.session) && learningObject(native.loaded)
      && native.session.name === 'session-release-review' && native.session.title === sessionLearningControl.name
      && learningObject(native.loaded.meta) && native.loaded.meta.title === sessionLearningControl.name
      && JSON.stringify(native.loaded.messages) === JSON.stringify([
        { role: 'user', content: 'Prepare the release review.' }, { role: 'assistant', content: sessionLearningControl.text },
      ])) return sessionLearningControl;
    if (learningObject(native.session) && learningObject(native.loaded)
      && native.session.name === 'session-auto-promote-test' && native.session.title === sessionPromotionControl.name
      && learningObject(native.loaded.meta) && native.loaded.meta.title === sessionPromotionControl.name
      && JSON.stringify(native.loaded.messages) === JSON.stringify([
        { role: 'user', content: 'Run auto-promote.' }, { role: 'assistant', content: sessionPromotionControl.text },
      ])) return sessionPromotionControl;
    const control = learningControls.find(item => native[item.nameField] === item.name && native[item.textField] === item.text);
    if (!control) throw new Error('Unscripted complete native learning fixture content');
    return control;
  };
  const assertLearningQuestion = (question: Question, expected: Question) => {
    if (JSON.stringify(question) !== JSON.stringify(expected)) throw new Error('Learning fixture question differs from its canonical closed schema');
  };
  const learningDefinition = (decision: object) => {
    const value: unknown = Object.getOwnPropertyDescriptor(decision, 'definition')?.value;
    if (!learningObject(value)) throw new Error('Missing original canonical learning fixture definition');
    return value;
  };
  const alignmentDefinition = learningDefinition(learningDuplicateAlignment);
  const selectionDefinition = learningDefinition(learningSurvivorSelection);
  const equivalenceDefinition = learningDefinition(learningSurvivorEquivalence);
  if (typeof alignmentDefinition.noun !== 'string' || typeof selectionDefinition.instructions !== 'string'
    || typeof selectionDefinition.fitInstructions !== 'string' || typeof equivalenceDefinition.condition !== 'string') throw new Error('Unexpected canonical learning definition grammar');
  const alignmentNoun = alignmentDefinition.noun, selectionInstructions = selectionDefinition.instructions;
  const selectionFitInstructions = selectionDefinition.fitInstructions, equivalenceCondition = equivalenceDefinition.condition;
  const scoreItems = new Map(Object.entries(learningCuratorScore.items));
  const duplicateLearningGroups = [
    [learningControls[3], learningControls[4]], [learningControls[10], learningControls[11]],
  ];
  const duplicateLearningGroup = (left: LearningControl, right: LearningControl) => duplicateLearningGroups.find(group => group[0] && group[1]
    && (group[0] === left && group[1] === right || group[0] === right && group[1] === left));
  const learningGradesFor = (state: unknown): LearningGrades => {
    if (!learningObject(state) || typeof state.proposedUse !== 'string' || typeof state.capturedAt !== 'string') throw new Error('Unexpected complete learning grade fixture state');
    if (learningObject(state.candidate) && state.candidate.id === 'capture:reviewed-lesson'
      && state.candidate.domain === 'capture' && state.candidate.status === 'ready'
      && learningObject(state.record) && state.record.noUrgentCandidates === true && learningObject(state.record.source)
      && state.record.source.capturedAt === state.capturedAt) {
      const source = state.record.source;
      const settledMemories = Array.isArray(source.memoryRecords) && source.memoryRecords.every(record => learningObject(record)
        && record.id === 'mem-briefing' && record.reviewState === 'reviewed' && record.confidence === 92
        && learningControl(record) === learningControls[0]);
      const emptySessions = Array.isArray(source.sessions) && source.sessions.length === 0;
      const noDurableWork = Array.isArray(source.workItems) && source.workItems.every(item => learningControl(item).target === 'none');
      const emptyLibraries = [['noteSnapshot', 'notes'], ['personaSnapshot', 'personas'], ['skillSnapshot', 'skills'], ['skillSnapshot', 'bundles'], ['routineSnapshot', 'routines']].every(([snapshot, rows]) => {
        if (!snapshot || !rows || !learningObject(source[snapshot])) return false;
        const library = source[snapshot];
        return Array.isArray(library[rows]) && (snapshot === 'noteSnapshot'
          ? library[rows].every(item => learningControl(item).target === 'none') : library[rows].length === 0);
      });
      if (!settledMemories || !emptySessions || !emptyLibraries || !noDurableWork) throw new Error('Unscripted learning capture fixture source');
      return { usefulness: 1, freshness: 3, source_quality: 3, risk: 0, priority: 1, confidence: 3 };
    }
    if (learningObject(state.candidate) && state.candidate.domain === 'vibe' && learningObject(state.candidate.proposalFields)
      && typeof state.candidate.recordId === 'string' && learningObject(state.record) && Array.isArray(state.record.files)) {
      const fields = state.candidate.proposalFields;
      const recordId = state.candidate.recordId;
      const body = fields.kind === 'blocked' && fields.scope === 'project' ? '# Project VIBE\n\napi_key=supersecretvalue\n'
        : fields.kind === 'truncated' && fields.scope === 'global' ? `# Global VIBE\n\n${'Prefer calm direct answers. '.repeat(420)}\n` : undefined;
      if (body !== undefined && state.record.files.some(file => learningObject(file) && file.path === recordId && file.body === body))
        return fields.kind === 'blocked' ? { usefulness: 3, freshness: 3, source_quality: 3, risk: 3, priority: 3, confidence: 3 } : ordinaryLearningGrades;
      throw new Error('Unscripted complete VIBE learning fixture content');
    }
    if (Array.isArray(state.record) && state.record.length === 2 && learningObject(state.candidate)
      && state.candidate.status === 'needs-consolidation') {
      const [left, right] = state.record.map(learningControl);
      if (left && right && state.candidate.domain === left.domain && duplicateLearningGroup(left, right)) return { usefulness: 3, freshness: 3, source_quality: 3, risk: 1, priority: 3, confidence: 3 };
      throw new Error('Unscripted complete learning consolidation fixture');
    }
    const control = learningControl(state.record);
    const domain = learningObject(state.candidate) ? state.candidate.domain : state.domain;
    if (domain !== control.domain) throw new Error('Learning fixture domain differs from the native source');
    return control.grades;
  };
  const learningScore = fakePort((name, question, state) => {
    const item = scoreItems.get(name);
    if (!item || question.type !== 'score') throw new Error(`Unscripted learning score question ${name}`);
    assertLearningQuestion(question, item.question);
    const grades = learningGradesFor(state);
    const grade = Object.entries(grades).find(([key]) => key === name)?.[1];
    if (grade === undefined) throw new Error(`Missing authored learning dimension ${name}`);
    return scoreAnswer(question, grade, 0.9999);
  });
  const learningTarget = fakePort((name, question, state) => {
    if (name !== 'target' || question.type !== 'choice' || !learningObject(state) || typeof state.origin !== 'string') throw new Error('Unexpected learning target fixture schema');
    assertLearningQuestion(question, learningProposalTarget.items.target.question);
    const control = learningControl(state.record);
    if (control.domain !== state.origin || control.target === undefined) throw new Error('Unscripted learning target fixture source');
    return choiceAnswer(question, control.target, 0.9999);
  });
  const learningQuality = fakePort((name, question, state) => {
    if (question.type !== 'score' || !learningObject(state) || !['proposal-ready', 'ready-to-promote'].includes(String(state.proposedUse))) throw new Error('Unscripted proposal quality source');
    const grades = learningGradesFor(state);
    const expected: Readonly<Record<string, number>> = { usefulness: grades.usefulness, sourceQuality: grades.source_quality, safety: 4 - grades.risk };
    const grade = expected[name];
    if (grade === undefined) throw new Error(`Unscripted proposal quality dimension ${name}`);
    return scoreAnswer(question, grade, 0.9999);
  });
  const learningMemoryClass = fakePort((name, question, state) => {
    if (name !== 'memory_class' || question.type !== 'choice' || !learningObject(state)
      || state.key !== 'Agent-local durable learning proposal' || !learningObject(state.value)) throw new Error('Unexpected learning memory-class fixture schema');
    assertLearningQuestion(question, memoryClass.items.memory_class.question);
    const control = learningControl(state.value.record);
    if (control.domain !== state.value.origin || control.memoryClass === undefined) throw new Error('Unscripted learning memory-class fixture source');
    return choiceAnswer(question, control.memoryClass, 0.9999);
  });
  const learningAlignment = fakePort((name, question, state) => {
    if (!learningObject(state) || !learningObject(state.entity_a) || !learningObject(state.entity_b)) throw new Error('Unexpected complete learning alignment fixture state');
    const left = learningControl(state.entity_a), right = learningControl(state.entity_b);
    if (left.domain !== right.domain || state.entity_a.domain !== left.domain || state.entity_b.domain !== right.domain) throw new Error('Learning alignment fixture domains differ');
    const same = duplicateLearningGroup(left, right) !== undefined;
    if (name === 'link' && question.type === 'score') {
      assertLearningQuestion(question, score(`How do \`entity_a\` and \`entity_b\` relate as ${alignmentNoun}s?`, [
        `They describe two different ${alignmentNoun}s.`,
        `They describe closely related ${alignmentNoun}s that may or may not be the same one: a variant, a special edition, a namesake, or a record that could plausibly refer to either.`,
        `They describe one and the same ${alignmentNoun}.`,
      ]));
      return scoreAnswer(question, same ? 2 : 0, 0.9999);
    }
    if (question.type === 'noul' && name === 'same_record') {
      assertLearningQuestion(question, noul('Do `entity_a` and `entity_b` state the same record?'));
      return noulAnswer(same ? 0.9999 : 0.0001);
    }
    throw new Error(`Unscripted learning alignment fixture question ${name}`);
  });
  const learningSelection = fakePort((name, question, state) => {
    if (!learningObject(state) || !learningObject(state.context) || state.selectionFitInstructions !== selectionFitInstructions
      || !Array.isArray(state.candidates) || state.candidates.length !== 2) throw new Error('Unexpected complete learning survivor fixture state');
    const controls = state.candidates.map(candidate => {
      if (!learningObject(candidate) || (candidate.id !== '0' && candidate.id !== '1')) throw new Error('Unexpected native learning candidate ID');
      return learningControl(candidate.content);
    });
    const left = controls[0], right = controls[1], group = left && right ? duplicateLearningGroup(left, right) : undefined;
    if (!group || !group[1] || state.context.domain !== group[1].domain) throw new Error('Unscripted substantive learning survivor group');
    const chosen = String(controls.indexOf(group[1]));
    if (name === 'pick' && question.type === 'choice') {
      assertLearningQuestion(question, choice(selectionInstructions, { '0': null, '1': null, none: 'None of the candidates does what is needed.' }));
      return choiceAnswer(question, chosen, 0.9999);
    }
    if (question.type === 'noul' && (name === 'fits_0' || name === 'fits_1')) {
      const index = name === 'fits_0' ? 0 : 1;
      assertLearningQuestion(question, noul({ question: 'Apply the complete selectionFitInstructions in state to this exact candidate.', candidate: `\`candidates[${index}]\` (id ${JSON.stringify(String(index))})` }));
      return noulAnswer(String(index) === chosen ? 0.9999 : 0.0001);
    }
    throw new Error(`Unscripted learning survivor fixture question ${name}`);
  });
  const learningEquivalence = fakePort((name, question, state) => {
    if (name !== 'item_0' || question.type !== 'noul' || !learningObject(state) || !Array.isArray(state.items) || state.items.length !== 1
      || !learningObject(state.items[0])) throw new Error('Unexpected complete learning equivalence fixture schema');
    assertLearningQuestion(question, noul({ question: equivalenceCondition, item: '`items[0]`' }));
    const selected = learningControl(state.items[0].selected), alternate = learningControl(state.items[0].alternate);
    const group = duplicateLearningGroup(selected, alternate);
    if (!group || group[1] !== selected || !learningObject(state.items[0].group)
      || state.items[0].group.domain !== selected.domain) throw new Error('Unscripted substantive learning equivalence fixture');
    return noulAnswer(0.0001);
  });
  const learningPorts = new Map([
    [learningCuratorScore.name, learningScore.port], [learningProposalTarget.name, learningTarget.port],
    [memoryClass.name, learningMemoryClass.port], [learningDuplicateAlignment.name, learningAlignment.port],
    [learningSurvivorSelection.name, learningSelection.port], [learningSurvivorEquivalence.name, learningEquivalence.port],
  ]);
  const researchSchema = fakePort((name, question, state) => {
    if (name !== 'match' || question.type !== 'noul' || !learningObject(state) || state.query !== 'Explicit schema certification'
      || !learningObject(state.candidate) || typeof state.candidate.evidenceJson !== 'string') throw new Error('Unscripted complete research schema fixture');
    const evidence: unknown = JSON.parse(state.candidate.evidenceJson);
    if (!learningObject(evidence) || evidence.explicit !== 'certified' || !Array.isArray(evidence.records)) throw new Error('Missing authored research certification evidence');
    const schemas: Readonly<Record<string, string>> = { 'live-runner-1': 'goodvibes.research.browser-run.v1', 'visual-report-render-1': 'goodvibes.research.visual-report.v1' };
    if (!evidence.records.some(record => learningObject(record) && typeof record.id === 'string'
      && schemas[record.id] === record.schemaVersion && record.schemaStatus === 'certified' && record.publisher === 'goodvibes-daemon')) throw new Error('Unscripted native research publisher');
    return noulAnswer(0.999);
  });
  const catalogGroups = fakePort((name, question, raw) => {
    const state = learningObject(raw) ? raw : undefined;
    const query = state && (typeof state.query === 'string' ? state.query : learningObject(state.query) ? state.query.query : undefined);
    const groups: Readonly<Record<string, string>> = {
      'durable non-secret default knowledge fallback': 'memory', memory: 'memory',
    };
    if (name !== 'match' || question.type !== 'noul' || typeof query !== 'string' || !Object.hasOwn(groups, query)
      || !state || !learningObject(state.candidate) || typeof state.candidate.evidenceJson !== 'string') throw new Error('Unscripted complete catalog group fixture');
    const evidence: unknown = JSON.parse(state.candidate.evidenceJson);
    if (!learningObject(evidence) || !learningObject(evidence.record) || typeof evidence.record.id !== 'string') throw new Error('Missing authored category evidence');
    return noulAnswer(evidence.record.id === groups[query] ? 0.999 : 0.001);
  });
  const catalogSelection = fakePort((name, question, state) => {
    if (!learningObject(state) || !learningObject(state.context) || typeof state.context.query !== 'string' || !Array.isArray(state.candidates)) throw new Error('Unscripted complete catalog selection fixture');
    const choices: Readonly<Record<string, string | null>> = {
      'default-knowledge': 'non-agent-knowledge', agent: null, 'not-a-capability': null,
      'fullscreen settings workspace': 'settings', 'streaming TTS provider picker': 'tts-provider-picker', picker: null,
      'live verification': null, 'not-release-evidence': null, Agent: null, 'new competitor research request': null, 'not-a-readiness-item': null,
      'durable non-secret default knowledge fallback': 'memory-create', memory: null,
    };
    const query = state.context.query;
    if (!Object.hasOwn(choices, query)) throw new Error(`Unscripted catalog selection fixture ${query}`);
    const rows = state.candidates.map(candidate => {
      if (!learningObject(candidate) || typeof candidate.id !== 'string' || typeof candidate.content !== 'string') throw new Error('Invalid catalog selection candidate');
      const content: unknown = JSON.parse(candidate.content);
      if (!learningObject(content) || typeof content.id !== 'string') throw new Error('Missing complete native catalog candidate');
      return { id: candidate.id, nativeId: content.id };
    });
    const selected = choices[query] === null ? 'none' : rows.find(row => row.nativeId === choices[query])?.id;
    if (!selected) throw new Error('Missing offered authored catalog choice');
    if (name === 'pick' && question.type === 'choice') return choiceAnswer(question, selected, 0.999);
    if (/^fits_\d+$/.test(name) && question.type === 'noul') {
      const row = rows[Number(name.slice(5))];
      if (!row) throw new Error('Invalid catalog fit index');
      return noulAnswer(row.id === selected ? 0.999 : 0.001);
    }
    throw new Error('Unscripted catalog selection question');
  });
  const deviceEvidence = fakePort((name, question, state) => {
    if (name !== 'supported' || question.type !== 'noul' || !learningObject(state) || state.kind !== 'device-capability'
      || !learningObject(state.record) || typeof state.record.id !== 'string' || state.record.schemaStatus !== 'certified') throw new Error('Unscripted device capability source');
    const capabilities: Readonly<Record<string, string>> = { 'device-sensors-live-1': 'camera-location-sensors', 'wake-word-live-1': 'wake-and-speak' };
    const capability = capabilities[state.record.id];
    if (!capability || state.record.capabilityId !== capability || !Array.isArray(state.requestedTerms)) throw new Error('Unscripted complete device evidence');
    return noulAnswer(state.requestedCapability === capability ? 0.999 : 0.001);
  });
  const port: JudgmentPort = {
    model: security.port.model,
    ask: async request => { try {
      const learning = learningPorts.get(request.context?.battery ?? '');
      if (learning) return await learning.ask(request);
      if (request.context?.battery === 'engine.tools.research-schema-status') return await researchSchema.port.ask(request);
      if (request.context?.battery === 'engine.tools.registry-catalog-group') return await catalogGroups.port.ask(request);
      if (request.context?.battery === 'engine.tools.registry-select') return await catalogSelection.port.ask(request);
      if (request.context?.battery === 'agent.browser-device.evidence') return await deviceEvidence.port.ask(request);
      if (request.context?.battery === 'engine.knowledge.learning-proposal-quality') return await learningQuality.port.ask(request);
      return await (['agent.models.local-benchmark-prompt', 'routing.local-server-identity',
      'agent.local-model.serving-status', 'agent.local-model.resource-pressure', 'agent.local-model.schema-status'].includes(request.context?.battery ?? '') ? localModels.port.ask(request)
      : request.context?.battery === 'agent.models.route-readiness' || request.context?.battery === 'agent.models.local-recipe-fit' ? readiness.port.ask(request)
      : request.context?.battery === 'routing.autonomy-intake' ? intake.port.ask(request)
      : request.context?.battery === 'agent.personal-ops.result-field' ? resultField.port.ask(request)
      : request.context?.battery === 'automation.schedule' ? intakeSchedule.port.ask(request)
      : ['agent.runtime.schema-status', 'agent.runtime.kind', 'agent.runtime.status', 'agent.runtime.route-role'].includes(request.context?.battery ?? '') ? interactiveRuntime.port.ask(request)
      : request.context?.battery === 'agent.tools.long-lived-process' ? lifetime.port.ask(request)
      : request.context?.battery === 'engine.gate.execution-verification' ? executionVerification.port.ask(request)
      : request.context?.battery === 'agent.remote-publisher.schema-status' || request.context?.battery === 'agent.remote-publisher.outcome-kind' ? publisher.port.ask(request)
      : request.context?.battery === 'agent.personal-ops.receipt-status' ? receiptStatus.port.ask(request)
      : ['agent.memory.route-role', 'agent.memory.credential-state', 'agent.memory.live-status', 'agent.memory.schema-certified',
        'agent.memory.receipt-member', 'agent.memory.provider-select', 'engine.runtime.at-rest-credential'].includes(request.context?.battery ?? '') ? memorySemantic.port.ask(request)
      : ['agent.personal-ops.lane-member', 'agent.personal-ops.tool-lane', 'agent.personal-ops.sample-field'].includes(request.context?.battery ?? '')
        || request.context?.battery === 'engine.gate.side-effect' && request.context?.site === 'agent.personal-ops.tool-effect'
        ? personalOpsDiscovery.port.ask(request)
      : ['engine.redaction.field-kind', 'engine.redaction.credential', 'engine.export.credential',
        'engine.redaction.residual-credential', 'engine.redaction.profile-distinctive'].includes(request.context?.battery ?? '') ? privacy.port.ask(request)
      : request.context?.battery === 'engine.gate.boundary' || request.context?.battery === 'engine.gate.side-effect' || request.context?.battery === 'engine.gate.risk-family'
        || request.context?.battery === 'engine.gate.autonomous-disposition' || request.context?.battery === 'engine.gate.autonomous-refusal' ? admission.port.ask(request)
      : request.context?.battery === 'engine.tools.registry-rank'
        && ['agent.harness.cli-commands', 'agent.harness.keybindings', 'agent.harness.shortcuts'].includes(request.context?.site ?? '') ? metadata.port.ask(request)
      : request.context?.battery === 'engine.tools.registry-rank' && request.context?.site === 'agent.memory.providers' ? memoryCatalog.port.ask(request)
      : request.context?.battery === 'engine.tools.registry-rank' ? personalOps.port.ask(request)
      : Object.keys(request.questions).length === 1 && Object.hasOwn(request.questions, 'credential')
      ? credentials.port.ask(request) : security.port.ask(request)); } catch (error) {
        process.stderr.write(JSON.stringify({ battery: request.context?.battery, site: request.context?.site, questions: Object.keys(request.questions),
          fixtureFailure: error instanceof Error && /^(Learning fixture|Unscripted|Missing authored)/.test(error.message) ? error.message : undefined }) + '\n');
        throw error;
      } },
  };
  return port;
}
