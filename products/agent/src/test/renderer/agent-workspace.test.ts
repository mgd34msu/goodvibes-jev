import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AgentNoteRegistry } from '../../agent/note-registry.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentPromptContextReceiptStore } from '../../agent/prompt-context-receipts.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { saveSetupWizardCheckpoint } from '../../agent/setup-wizard-checkpoint.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { createAgentRuntimeProfile, setAgentRuntimeProfileSelection } from '../../agent/runtime-profile.ts';
import { routineScheduleReceiptStorePath } from '../../agent/routine-schedule-receipts.ts';
import { AgentWorkspace } from '../../input/agent-workspace.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { renderAgentWorkspace } from '../../renderer/agent-workspace.ts';
import type { SurfaceLayer } from '../../renderer/surface-kit.ts';
import { createShellPathService } from '@/runtime/index.ts';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { ConfigSetting } from '@goodvibes-jev/engine/sdk/platform/config';
import type { MemoryApi } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import type { MemoryRecord } from '@goodvibes-jev/engine/sdk/platform/state';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/** The workspace modal's text (it is a kit layer drawn over the screen). */
function text(layer: SurfaceLayer): string {
  return layer.lines.map((line) => line.map((cell) => cell.char ?? ' ').join('').trimEnd()).join('\n');
}

function commandContext(): CommandContext {
  return {
    executeCommand: async () => true,
    print: () => undefined,
  } as unknown as CommandContext;
}

function configSetting(
  key: string,
  type: ConfigSetting['type'],
  defaultValue: unknown,
  enumValues?: readonly string[],
): ConfigSetting {
  return {
    key: key as ConfigSetting['key'],
    type,
    default: defaultValue,
    description: `${key} test setting`,
    ...(enumValues ? { enumValues: [...enumValues] } : {}),
  };
}

function onboardingConfigContext(values: Record<string, unknown>): CommandContext {
  const configValues = new Map<string, unknown>(Object.entries(values));
  const schema: ConfigSetting[] = [
    configSetting('surfaces.ntfy.enabled', 'boolean', false),
    configSetting('surfaces.ntfy.token', 'string', ''),
    configSetting('provider.reasoningEffort', 'enum', 'medium', ['low', 'medium', 'high']),
    configSetting('storage.secretPolicy', 'enum', 'system', ['system', 'file-ref', 'disabled']),
    configSetting('behavior.saveHistory', 'boolean', true),
  ];
  return {
    executeCommand: async () => true,
    print: () => undefined,
    platform: {
      configManager: {
        get: (key: string) => configValues.get(key),
        getSchema: () => schema,
      },
    },
  } as unknown as CommandContext;
}

function memoryRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = Date.now();
  return {
    id: 'mem-preference',
    scope: 'project',
    cls: 'fact',
    summary: 'Prefers concise operator briefings',
    detail: 'Use short summaries before action.',
    tags: ['preference'],
    provenance: [],
    reviewState: 'fresh',
    confidence: 82,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function memoryApi(records: MemoryRecord[] = [memoryRecord()]): MemoryApi {
  return {
    add: async (input) => {
      const record = memoryRecord({
        id: `mem-${records.length + 1}`,
        scope: input.scope ?? 'project',
        cls: input.cls,
        summary: input.summary,
        detail: input.detail,
        tags: [...(input.tags ?? [])],
        provenance: [...(input.provenance ?? [])],
        reviewState: input.review?.state ?? 'fresh',
        confidence: input.review?.confidence ?? 80,
      });
      records.unshift(record);
      return record;
    },
    search: async () => records,
    searchSemantic: async () => [],
    vectorStats: () => ({
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: 'none',
      embeddingProviderLabel: 'None',
    }),
    rebuildVectors: () => ({
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: 'none',
      embeddingProviderLabel: 'None',
    }),
    rebuildVectorsAsync: async () => ({
      backend: 'sqlite-vec',
      enabled: false,
      available: false,
      path: '',
      dimensions: 0,
      indexedRecords: 0,
      embeddingProviderId: 'none',
      embeddingProviderLabel: 'None',
    }),
    doctor: async () => ({
      vector: {
        backend: 'sqlite-vec',
        enabled: false,
        available: false,
        path: '',
        dimensions: 0,
        indexedRecords: 0,
        embeddingProviderId: 'none',
        embeddingProviderLabel: 'None',
      },
      embeddings: {
        activeProviderId: 'none',
        providers: [],
        asyncProviders: [],
        syncProviders: [],
        warnings: [],
      },
      checkedAt: Date.now(),
    }),
    reviewQueue: async () => records.slice(0, 100),
    exportBundle: () => ({
      schemaVersion: 'v1',
      exportedAt: Date.now(),
      scope: 'all',
      recordCount: records.length,
      linkCount: 0,
      records,
      links: [],
    }),
    importBundle: async () => ({ importedRecords: 0, skippedRecords: 0, importedLinks: 0 }),
    get: (id) => records.find((record) => record.id === id) ?? null,
    getAll: () => records,
    link: async () => null,
    linksFor: () => [],
    update: (id, patch) => {
      const index = records.findIndex((record) => record.id === id);
      const current = records[index];
      if (!current) return null;
      const updated = {
        ...current,
        ...patch,
        updatedAt: Date.now(),
      };
      records[index] = updated;
      return updated;
    },
    review: (id, patch) => {
      const index = records.findIndex((record) => record.id === id);
      const current = records[index];
      if (!current) return null;
      const updated = {
        ...current,
        reviewState: patch.state ?? current.reviewState,
        confidence: patch.confidence ?? current.confidence,
        reviewedBy: patch.reviewedBy ?? current.reviewedBy,
        reviewedAt: Date.now(),
        staleReason: patch.staleReason,
        updatedAt: Date.now(),
      };
      records[index] = updated;
      return updated;
    },
    delete: (id) => {
      const index = records.findIndex((record) => record.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
    },
    explain: async () => ({
      injections: [],
      prompt: null,
    }),
  };
}

function reviewerHandoffArtifact(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly handoffId: string;
  readonly comparisonId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: string;
  readonly relatedArtifactIds: readonly string[];
}): ArtifactDescriptor {
  return {
    id: input.id,
    kind: 'data',
    mimeType: 'text/markdown',
    filename: `blind-model-comparison-handoff-${input.handoffId}.md`,
    sizeBytes: 1024,
    sha256: `sha-${input.id}`,
    createdAt: input.createdAt,
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: {
      purpose: 'agent-model-compare-handoff',
      handoffId: input.handoffId,
      comparisonId: input.comparisonId,
      sourceArtifactId: input.sourceArtifactId,
      sourceKind: input.sourceKind,
      relatedArtifactIds: input.relatedArtifactIds,
    },
  };
}

function reviewPacketArtifact(input: {
  readonly id: string;
  readonly createdAt: number;
  readonly filename: string;
  readonly metadata: Record<string, unknown>;
  readonly kind?: ArtifactDescriptor['kind'];
  readonly mimeType?: string;
}): ArtifactDescriptor {
  return {
    id: input.id,
    kind: input.kind ?? 'data',
    mimeType: input.mimeType ?? 'application/json',
    filename: input.filename,
    sizeBytes: 512,
    sha256: `sha-${input.id}`,
    createdAt: input.createdAt,
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: input.metadata,
  };
}

function liveCommandContext(options: {
  readonly includePersonalOpsNote?: boolean;
  readonly includeReviewerIssue?: boolean;
  readonly reviewerHandoffs?: readonly ArtifactDescriptor[];
  readonly setupCheckpointStepId?: string;
  readonly includePromptReceipts?: boolean;
} = {}): CommandContext {
  const root = makeProjectTempDir('goodvibes-agent-workspace-render');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  if (options.setupCheckpointStepId) {
    saveSetupWizardCheckpoint(shellPaths, {
      currentStepId: options.setupCheckpointStepId,
      currentStepLabel: options.setupCheckpointStepId === 'install-smoke' ? 'Install smoke' : 'Provider and model',
      source: 'workspace',
      note: 'Renderer fixture checkpoint.',
    });
  }
  const tokenDir = join(root, '.goodvibes', 'daemon');
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'operator-tokens.json'), JSON.stringify({ token: 'goodvibes-agent-test-token' }));
  createAgentRuntimeProfile(root, 'household');
  setAgentRuntimeProfileSelection(root, 'household');
  const configValues = new Map<string, unknown>([
    ['controlPlane.host', '127.0.0.1'],
    ['controlPlane.port', 3421],
    ['provider.reasoningEffort', 'medium'],
    ['storage.secretPolicy', 'system'],
    ['behavior.saveHistory', true],
    ['surfaces.slack.enabled', true],
    ['surfaces.slack.botToken', 'goodvibes://secrets/goodvibes/SLACK_BOT_TOKEN'],
    ['surfaces.slack.signingSecret', 'goodvibes://secrets/goodvibes/SLACK_SIGNING_SECRET'],
    ['surfaces.slack.defaultChannel', 'ops-alerts'],
    ['surfaces.telegram.enabled', true],
    ['surfaces.telegram.botToken', 'goodvibes://secrets/goodvibes/TELEGRAM_BOT_TOKEN'],
    ['tts.provider', 'elevenlabs'],
    ['tts.voice', 'voice-operator'],
    ['tts.llmProvider', 'openai-subscriber'],
    ['tts.llmModel', 'gpt-5.5'],
    ['ui.voiceEnabled', true],
    ['web.enabled', true],
    ['web.publicBaseUrl', 'https://agent.example.test'],
  ]);
  const personas = AgentPersonaRegistry.fromShellPaths(shellPaths);
  personas.create({
    name: 'Research Analyst',
    description: 'Source-backed research posture.',
    body: 'Prefer checked sources and clear unknowns.',
  });
  personas.setActive('research-analyst');
  const skills = AgentSkillRegistry.fromShellPaths(shellPaths);
  skills.create({
    name: 'Briefing',
    description: 'Summarize state before action.',
    procedure: 'Review current daemon, tasks, and approvals first.',
    requirements: [{ kind: 'env', name: 'GOODVIBES_AGENT_TEST_MISSING_TOKEN' }],
    enabled: true,
  });
  skills.createBundle({
    name: 'Operator Pack',
    description: 'Use the core operator procedures together.',
    skillIds: ['briefing'],
    enabled: true,
  });
  const routines = AgentRoutineRegistry.fromShellPaths(shellPaths);
  routines.create({
    name: 'Daily Brief',
    description: 'Summarize operator state.',
    steps: 'Review current daemon, tasks, approvals, and Agent Knowledge status first.',
    requirements: [{ kind: 'env', name: 'GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN' }],
    enabled: true,
  });
  if (options.includePersonalOpsNote === true) {
    AgentNoteRegistry.fromShellPaths(shellPaths).create({
      title: 'Follow-up queue',
      body: 'Track replies, calendar holds, and reminder ideas.',
      tags: ['personal-ops'],
      source: 'agent',
      provenance: 'test',
    });
  }
  const promptContextReceipts = new AgentPromptContextReceiptStore();
  if (options.includePromptReceipts === true) {
    promptContextReceipts.record({
      sessionId: 'agent-session-1',
      turnId: 'turn-renderer-fail',
      source: 'turn',
      provider: 'openai-subscriber',
      model: 'openai:gpt-5.5',
      contextWindow: 256000,
      promptHash: 'c'.repeat(64),
      promptChars: 2048,
      approxPromptTokens: 512,
      activeRecords: 3,
      suppressedRecords: 1,
      segments: [
        {
          id: 'vibe',
          label: 'VIBE.md',
          order: 10,
          status: 'active',
          activeCount: 1,
          suppressedCount: 0,
          promptChars: 256,
          approxTokens: 64,
        },
        {
          id: 'memory',
          label: 'Memory',
          order: 30,
          status: 'attention',
          activeCount: 2,
          suppressedCount: 1,
          promptChars: 512,
          approxTokens: 128,
        },
      ],
    });
    promptContextReceipts.recordTurnOutcome({
      turnId: 'turn-renderer-fail',
      status: 'error',
      terminalEvent: 'TURN_ERROR',
      stopReason: 'provider_error',
      detail: 'Provider rejected the test request.',
      completedAt: 1_700_000_000_000,
    });
  }
  if (options.includeReviewerIssue === true) {
    const documents = AgentDocumentRegistry.fromShellPaths(shellPaths);
    const draft = documents.create({
      title: 'Reviewer packet',
      body: 'Draft packet body.',
      tags: ['review'],
    });
    documents.addComment(draft.id, { body: 'Resolve this before export.' });
  }
  return {
    executeCommand: async () => true,
    print: () => undefined,
    session: {
      runtime: {
        model: 'openai:gpt-5.5',
        provider: 'openai-subscriber',
        sessionId: 'agent-session-1',
        debugMode: false,
        systemPrompt: '',
        reasoningEffort: 'medium',
      },
      sessionMemoryStore: { list: () => [{ id: 'mem-1', text: 'remembered preference' }] },
    },
    provider: {
      providerRegistry: {
        getCurrentModel: () => ({
          id: 'gpt-5.5',
          provider: 'openai-subscriber',
          displayName: 'GPT-5.5',
          registryKey: 'openai:gpt-5.5',
          contextWindow: 256000,
        }),
      },
    },
    workspace: {
      shellPaths,
      processManager: {
        list: () => [],
        getStatus: () => undefined,
      },
      profileManager: {
        list: () => [
          { name: 'operator', timestamp: Date.now() },
          { name: 'travel', timestamp: Date.now() - 1000 },
        ],
      },
    },
    clients: {
      agentKnowledgeApi: {
        memory: memoryApi(),
      },
      mcpApi: {
        listServerSecurity: () => [
          {
            name: 'filesystem',
            connected: true,
            role: 'filesystem',
            trustMode: 'constrained',
            schemaFreshness: 'fresh',
            allowedPaths: ['/home/buzzkill/Projects'],
            allowedHosts: [],
          },
          {
            name: 'browser',
            connected: false,
            role: 'browser',
            trustMode: 'allow-all',
            schemaFreshness: 'quarantined',
            allowedPaths: [],
            allowedHosts: ['docs.example.test'],
          },
        ],
      },
      ...(options.includePromptReceipts === true ? { promptContextReceipts } : {}),
    },
    platform: {
      configManager: {
        get: (key: string) => configValues.get(key),
        getSchema: () => [
          configSetting('provider.reasoningEffort', 'enum', 'medium', ['low', 'medium', 'high']),
          configSetting('storage.secretPolicy', 'enum', 'system', ['system', 'file-ref', 'disabled']),
          configSetting('behavior.saveHistory', 'boolean', true),
          configSetting('surfaces.slack.enabled', 'boolean', false),
          configSetting('surfaces.slack.botToken', 'string', ''),
          configSetting('surfaces.slack.signingSecret', 'string', ''),
          configSetting('surfaces.telegram.enabled', 'boolean', false),
          configSetting('surfaces.telegram.botToken', 'string', ''),
          configSetting('tts.provider', 'string', ''),
          configSetting('tts.voice', 'string', ''),
          configSetting('ui.voiceEnabled', 'boolean', false),
        ],
      },
      voiceProviderRegistry: {
        list: () => [
          { id: 'elevenlabs', label: 'ElevenLabs', capabilities: ['tts-stream', 'stt', 'realtime'] },
          { id: 'deepgram', label: 'Deepgram', capabilities: ['stt'] },
        ],
      },
      mediaProviderRegistry: {
        list: () => [
          { id: 'builtin:image-understanding', label: 'Image Understanding', capabilities: ['understand'] },
          { id: 'fal', label: 'Fal', capabilities: ['generate'] },
        ],
      },
      ...(options.reviewerHandoffs
        ? { artifactStore: { list: (limit = 100) => options.reviewerHandoffs!.slice(0, limit) } }
        : {}),
    },
  } as unknown as CommandContext;
}

describe('renderAgentWorkspace', () => {
  test('renders the operator workspace with categories, actions, and footer controls', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);

    const output = text(renderAgentWorkspace(workspace, 120, 42));

    expect(output).toContain('Agent workspace');
    expect(output).toContain('Home');
    expect(output).toContain('Get the assistant working');
    expect(output).toContain('Talk and choose models');
    expect(output).toContain('Assistant: attention');
    expect(output).toContain('Set interaction mode');
    // Footer controls are keycap hints now.
    expect(output).toContain('⏎  open');
    expect(output).toContain('R  refresh');
  });

  test('renders workspace action search as a TUI-native finder', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);
    workspace.beginActionSearch();
    workspace.appendActionSearchText('doctor');

    const output = text(renderAgentWorkspace(workspace, 120, 42));

    expect(output).toContain('Search actions');
    expect(output).toContain('Action Search');
    expect(output).toContain('Query: doctor');
    expect(output).toContain('Knowledge / Connector doctor');
    expect(output).toContain('Messaging / Diagnose a channel');
    expect(output).toContain('↑↓  results');
    expect(output).toContain('esc  clear');
  });

  test('renders build delegation as an explicit TUI handoff area', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');

    const output = text(renderAgentWorkspace(workspace, 130, 54));

    expect(output).toContain('Work & Approvals');
    expect(output).toContain('Delegate a build task');
    expect(output).not.toContain('coding transcript');
  });

  test('renders live Agent context from the command runtime', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    const output = text(renderAgentWorkspace(workspace, 132, 60));

    expect(output).toContain('Assistant: ready-with-optional-setup; chat route openai-subscriber / GPT-5.5');
    expect(output).toContain('openai-subscriber / GPT-5.5');
    expect(output).toContain('Handle personal operations');
    expect(output).toContain('Stay safe and recover');
    expect(output).not.toContain('agent-session-1');
    expect(output).not.toContain('serial-proactive');
    expect(output).not.toContain('goodvibes-agent-test-token');
  });

  test('renders real onboarding actions in the Start workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 60));

    expect(output).toContain('Selected: Use a local model (no sign-in)');
    expect(output).toContain('Onboarding');
    expect(output).toContain('of 13 done');
    expect(output).toContain('Chat: openai-subscriber / GPT-5.5.');
    expect(output).toContain('Local: 1 personas, 1 skills, 1 routines, 1 memories.');
    expect(output).toContain('Next: Agent Knowledge (recommended)');
    expect(output).toContain('Setting');
    expect(output).toContain('Default');
    expect(output).toContain('Current');
    expect(output).toContain('Import GoodVibes settings');
    expect(output).toContain('Choose main model');
    expect(output).toContain('Sign in to a provider');
    expect(output).not.toContain('Setup wizard:');
    expect(output).not.toContain('Wizard next:');
    expect(output).not.toContain('Setup closeout:');
    expect(output).not.toContain('->');
    expect(output).not.toContain('Does:');
    expect(output).not.toContain('Command:');
    expect(output).not.toContain('setting provider.reasoningEffort');
    expect(output).not.toContain('SLACK_BOT_TOKEN');
    expect(output).not.toContain('daemonBaseUrl');
    expect(output).not.toContain('daemon URL');
    expect(output).not.toContain('External Daemon');
    expect(output).not.toContain('service mode');
    expect(output).not.toContain('HTTP listeners');
    expect(output).not.toContain('tunnel provider setup');
    expect(output).not.toContain('non-Agent assistant segment');
    expect(output).not.toContain('non-Agent graph segment');
  });

  test('focuses setup wizard on repeated saved smoke blockers', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({
      reviewerHandoffs: [
        reviewPacketArtifact({
          id: 'setup-smoke-new',
          filename: 'setup-smoke-new.md',
          createdAt: 2000,
          metadata: {
            purpose: 'agent-setup-smoke-evidence',
            result: 'blocked',
            smokeStatus: 'blocked',
            blockedChecks: ['setup-posture'],
          },
        }),
        reviewPacketArtifact({
          id: 'setup-smoke-old',
          filename: 'setup-smoke-old.md',
          createdAt: 1000,
          metadata: {
            purpose: 'agent-setup-smoke-evidence',
            result: 'blocked',
            smokeStatus: 'blocked',
            blockedChecks: ['setup-posture'],
          },
        }),
      ],
    }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 62));

    expect(output).toContain('Onboarding');
    expect(output).toContain('need attention');
    expect(output).not.toContain('Setup wizard:');
    expect(output).not.toContain('Repeated blocker:');
    expect(output).not.toContain('Smoke history:');
    expect(output).not.toContain('Step history:');
    expect(output).not.toContain('Receipt gaps:');
  });

  test('renders durable setup receipts as first-run readiness evidence', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({
      reviewerHandoffs: [
        reviewPacketArtifact({
          id: 'setup-service-ready',
          filename: 'setup-service-ready.json',
          createdAt: 3000,
          metadata: {
            purpose: 'connected-host-setup-receipt',
            methodId: 'services.status',
            receiptId: 'svc-ready',
            receiptStatus: 'ready',
            recordedAt: '1970-01-01T00:00:03.000Z',
            summary: 'services.status reported healthy.',
          },
        }),
        reviewPacketArtifact({
          id: 'setup-smoke-ready',
          filename: 'setup-smoke-ready.json',
          createdAt: 4000,
          metadata: {
            purpose: 'agent-setup-receipt',
            setupStepId: 'install-smoke',
            receiptId: 'smoke-ready',
            receiptStatus: 'ready',
            recordedAt: '1970-01-01T00:00:04.000Z',
            summary: 'Setup smoke completed with first assistant turn.',
          },
        }),
        reviewPacketArtifact({
          id: 'setup-browser-ready',
          filename: 'setup-browser-ready.json',
          createdAt: 5000,
          metadata: {
            purpose: 'connected-host-browser-pwa-receipt',
            methodId: 'browser.pwa.firstRun',
            receiptId: 'browser-ready',
            receiptStatus: 'published',
            recordedAt: '1970-01-01T00:00:05.000Z',
            summary: 'Browser/PWA first-run completed.',
          },
        }),
      ],
    }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 62));

    expect(output).toContain('Onboarding');
    expect(output).toContain('of 13 done');
    expect(output).not.toContain('Step history:');
    expect(output).not.toContain('Receipt gaps:');
    expect(output).not.toContain('durable setup receipt');
  });

  test('renders saved setup checkpoint state on Start', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({ setupCheckpointStepId: 'install-smoke' }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 62));

    expect(output).toContain('Onboarding');
    expect(output).toContain('Save resume point');
    expect(output).toContain('Clear saved resume point');
    expect(output).not.toContain('Setup checkpoint:');
  });

  test('renders Personal Ops as one daily operations surface', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({ includePersonalOpsNote: true }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personal-ops');

    const output = text(renderAgentWorkspace(workspace, 132, 72));

    expect(output).toContain('Personal Ops');
    expect(output).toContain('Personal Ops: notes 1; routines 1/1');
    expect(output).toContain('Daily briefing plan');
    expect(output).toContain('Daily brief: plan inbox, agenda, tasks');
    expect(output).toContain('Request planner');
    expect(output).toContain('Autonomy queue');
    expect(output).toContain('inspect owners, status, and cancel/recovery routes');
    expect(output).toContain('Email/calendar: connector setup needed');
    expect(output).toContain('Create reminder');
    expect(output).toContain('Delivery channels');
    expect(output).toContain('personal_ops action:"briefing|status|queue|intake|lane|read"');
  });

  test('renders Documents & Files as a visible artifact and compare surface', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'documents');

    let output = text(renderAgentWorkspace(workspace, 132, 64));

    expect(output).toContain('Documents & Files');
    expect(output).toContain('Browse document drafts');
    expect(output).toContain('Show document draft');
    expect(output).toContain('Create document draft');
    expect(output).toContain('Revise document draft');
    expect(output).toContain('Add review comment');
    expect(output).toContain('Resolve review comment');
    expect(output).toContain('Propose AI suggestion');
    expect(output).toContain('Accept suggestion');
    expect(output).toContain('Reject suggestion');
    expect(output).toContain('Insert artifact in draft');
    expect(output).toContain('Review packet timeline');
    expect(output).toContain('Review packet wizard');
    expect(output).toContain('Refresh packet preset');
    expect(output).toContain('Share review packet');
    expect(output).toContain('Review readiness preflight');
    expect(output).toContain('Export document artifact');
    expect(workspace.actions.some((action) => action.id === 'document-export-artifact-file')).toBe(true);
    expect(workspace.actions.some((action) => action.id === 'document-export-artifact-package')).toBe(true);
    expect(output).toContain('agent_harness mode:"document_ops"');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-reviewer-readiness');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 132, 64));
    expect(output).toContain('Review Readiness Preflight');
    expect(output).toContain('Repair routes');
    expect(output).toContain('Preflight checks: comments, suggestions, source artifacts');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-diff-handoffs');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 132, 64));
    expect(output).toContain('Diff Reviewer Handoffs');
    expect(output).toContain('Left handoff');
    expect(output).toContain('No complete handoff pair selected; submitting lists recent saved handoffs.');
    expect(output).toContain('Section jump');
    expect(output).toContain('Section jumps: all, metadata, policy, related, comparison.');
  });

  test('prefills reviewer handoff diff form from recent artifact metadata', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({
      reviewerHandoffs: [
        reviewerHandoffArtifact({
          id: 'artifact-newer',
          createdAt: 1_700_000_010_000,
          handoffId: 'hnd_newer',
          comparisonId: 'cmp_launch',
          sourceArtifactId: 'artifact-source-2',
          sourceKind: 'comparison',
          relatedArtifactIds: ['doc-export-2', 'brief-2'],
        }),
        reviewerHandoffArtifact({
          id: 'artifact-older',
          createdAt: 1_700_000_000_000,
          handoffId: 'hnd_older',
          comparisonId: 'cmp_launch',
          sourceArtifactId: 'artifact-source-1',
          sourceKind: 'judgment',
          relatedArtifactIds: ['doc-export-1'],
        }),
      ],
    }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'documents');

    let output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Reviewer handoffs: 2 saved; diff defaults artifact-older -> artifact-newer.');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-diff-handoffs');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Current diff: artifact-older -> artifact-newer.');
    expect(output).toContain('Recent choices: artifact-newer');
    expect(output).toContain('artifact-older (judgment; related 1).');
    expect(output).toContain('Older handoff hnd_older');
  });

  test('renders a chronological review packet timeline for documents and compare artifacts', () => {
    const now = Date.now();
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({
      includeReviewerIssue: true,
      reviewerHandoffs: [
        reviewerHandoffArtifact({
          id: 'handoff-launch',
          createdAt: now + 3_000,
          handoffId: 'hnd_launch',
          comparisonId: 'cmp_launch',
          sourceArtifactId: 'judgment-launch',
          sourceKind: 'judgment',
          relatedArtifactIds: [],
        }),
        reviewPacketArtifact({
          id: 'preset-launch',
          createdAt: now + 4_000,
          filename: 'review-packet-preset-launch.json',
          metadata: {
            purpose: 'agent-review-packet-preset',
            presetId: 'preset_launch',
            name: 'Launch packet preset',
            summary: 'document reviewer-packet; source judgment-launch; handoff handoff-launch; 1 related',
            documentId: 'reviewer-packet',
            documentTitle: 'Reviewer packet',
            documentExportArtifactId: 'doc-export-launch',
            revealedJudgmentArtifactId: 'judgment-launch',
            handoffArtifactId: 'handoff-launch',
            relatedArtifactIds: ['doc-export-launch'],
            refreshOfArtifactId: 'preset-old',
            refreshOfPresetId: 'preset_old',
            freshnessMissingCount: 1,
            freshnessSupersededCount: 2,
            freshnessUnresolvedCount: 0,
          },
        }),
        reviewPacketArtifact({
          id: 'judgment-launch',
          createdAt: now + 2_000,
          filename: 'blind-model-comparison-judgment-launch.json',
          metadata: {
            purpose: 'agent-model-compare-judgment',
            judgmentId: 'jdg_launch',
            comparisonId: 'cmp_launch',
            winnerBlindId: 'B',
            winnerModel: 'openai:gpt-5.5',
            revealIncludedInJudgment: true,
          },
        }),
        reviewPacketArtifact({
          id: 'compare-launch',
          createdAt: now + 1_000,
          filename: 'blind-model-comparison-cmp_launch.json',
          metadata: {
            purpose: 'agent-model-compare',
            comparisonId: 'cmp_launch',
            candidateCount: 2,
            completedCandidates: 2,
            revealIncludedInTranscript: false,
            sourceArtifactId: 'doc-export-launch',
          },
        }),
      ],
    }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'documents');

    let output = text(renderAgentWorkspace(workspace, 150, 66));

    expect(output).toContain('Review packet timeline:');
    expect(output).toContain('Packet packet-preset: Packet preset: Launch packet preset');
    expect(output).toContain('Packet handoff: Reviewer handoff: hnd_launch');
    expect(output).toContain('Packet judgment: Comparison judgment revealed: cmp_launch');
    expect(output).toContain('Packet next:');
    expect(output).toContain('related artifact(s)');
    expect(output).toContain('Packet wizard:');
    expect(output).toContain('current Draft review');
    expect(output).toContain('Packet defaults: document reviewer-packet');
    expect(output).toContain('1 related; preset');
    expect(output).toContain('preset-launch');
    expect(output).toContain('Preset lineage:');
    expect(output).toContain('refreshed from preset-old');
    expect(output).toContain('repaired 3');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-review-packet-wizard');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 150, 66));
    expect(output).toContain('Review Packet Wizard');
    expect(output).toContain('Walk the current reviewer packet');
    expect(output).toContain('Focus');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-export-draft');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 150, 66));
    expect(output).toContain('Packet default: document reviewer-packet');
    expect(output).toContain('reviewer-packet');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-export-compare');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 150, 66));
    expect(output).toContain('Default archive uses the latest reviewer handoff');
    expect(output).toContain('handoff-launch');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-apply-compare');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 150, 66));
    expect(output).toContain('Default from latest revealed packet judgment');
    expect(output).toContain('judgment-launch');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-save-review-packet-preset');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 150, 66));
    expect(output).toContain('Save Review Packet Preset');
    expect(output).toContain('Launch packet preset');
    expect(output).toContain('doc-export-launch');
    expect(output).toContain('judgment-launch');
  });

  test('shows reviewer-readiness badges at export archive and route-apply points', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({
      includeReviewerIssue: true,
      reviewerHandoffs: [],
    }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'documents');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-export-draft');
    workspace.activateSelected();
    let output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Document export readiness: attention');
    expect(output).toContain('1 comment(s)');
    expect(output).toContain('source/evidence gap(s)');
    expect(output).toContain('Preflight next: Resolve open comments');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-export-compare');
    workspace.activateSelected();
    if (workspace.localEditor) {
      workspace.localEditor = {
        ...workspace.localEditor,
        fields: workspace.localEditor.fields.map((field) => field.id === 'reportKind' ? { ...field, value: 'archive' } : field),
      };
    }
    output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Handoff archive readiness: attention');
    expect(output).toContain('Preflight next: Resolve open comments');
    workspace.cancelLocalEditor();

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'document-apply-compare');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Route apply readiness: attention');
    expect(output).toContain('Preflight next: Resolve open comments');
  });

  test('renders Research with source report artifacts and a confirmed save form', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'research');

    let output = text(renderAgentWorkspace(workspace, 132, 64));
    expect(output).toContain('Research');
    expect(output).toContain('Research route: openai-subscriber / GPT-5.5');
    expect(output).toContain('Research runs: 0 running; 0 paused; 0 blocked; 0 planned.');
    expect(output).toContain('Source queue: 0 candidate; 0 reviewed; 0 rejected; 0 used.');
    expect(output).toContain('Browser runner contract: needs setup review');
    expect(output).toContain('Runner requires: visible run controls, source capture receipts, bounded logs, report handoff.');
    expect(output).toContain('Visual report contract: waiting for reviewed sources');
    expect(output).toContain('Report requires: at-a-glance, evidence matrix, source map, citations, handoff, archive.');
    expect(output).toContain('Briefing: one read-only next-action queue with confirmed routes.');
    expect(output).toContain('Web and URL inspection stay read-only');
    expect(output).toContain('Model route: research action:"briefing|plan|search|runner|runs|sources|reports|report".');
    expect(output).toContain('Research in conversation');
    expect(output).toContain('Inspect URL');
    expect(output).toContain('Research briefing');
    expect(output).toContain('Plan workflow');
    expect(output).toContain('Browser runner readiness');
    expect(output).toContain('Research runs');
    expect(output).toContain('Public source search');
    expect(output).toContain('Start research run');
    expect(output).toContain('Source queue');
    expect(output).toContain('Add source to queue');
    expect(output).toContain('Report artifacts');
    expect(output).toContain('Save research report');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'research-save-report');
    workspace.activateSelected();
    output = text(renderAgentWorkspace(workspace, 132, 64));
    expect(output).toContain('Save Research Report');
    expect(output).toContain('Title *');
    expect(output).toContain('Question *');
    expect(output).toContain('Sources *');
    expect(workspace.localEditor?.fields.some((field) => field.id === 'confidence')).toBe(true);
    expect(workspace.localEditor?.fields.some((field) => field.id === 'visualReport' && field.value === 'yes')).toBe(true);
    expect(workspace.localEditor?.fields.some((field) => field.id === 'confirm' && field.required)).toBe(true);
  });

  test('keeps onboarding context compact enough to show setting actions', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined, 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 47));

    expect(output).toContain('Selected: Use a local model (no sign-in)');
    expect(output).toContain('Choose main model');
    expect(output).toContain('Save history');
    expect(output).not.toContain('Setup Checklist');
    expect(output).not.toContain('RECOMMENDED');
    expect(output).not.toContain('->');
    expect(output).not.toContain('Setup wizard:');
    expect(output).not.toContain('Wizard next:');
  });

  test('renders onboarding setting pages as default and current value columns', () => {
    let workspace = new AgentWorkspace();
    workspace.open(onboardingConfigContext({
      'surfaces.ntfy.enabled': false,
      'surfaces.ntfy.token': 'goodvibes://secrets/goodvibes/NTFY_TOKEN',
    }), () => undefined, 'onboarding-channels');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-ntfy-enabled');
    let output = text(renderAgentWorkspace(workspace, 180, 58));

    expect(output).toContain('Setting');
    expect(output).toContain('Default');
    expect(output).toContain('Current');
    expect(output).toContain('Use ntfy');
    expect(output).toContain('false');
    expect(output).toContain('About: Turn on ntfy to get push notifications');
    expect(output).not.toContain('Change');
    expect(output).not.toContain('->');
    expect(output).not.toContain('Action  Does');
    expect(output).not.toContain('Does:');
    expect(output).not.toContain('setting surfaces.ntfy.enabled');

    workspace = new AgentWorkspace();
    workspace.open(onboardingConfigContext({
      'surfaces.ntfy.enabled': true,
      'surfaces.ntfy.token': 'goodvibes://secrets/goodvibes/NTFY_TOKEN',
    }), () => undefined, 'onboarding-channels');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-ntfy-token');
    output = text(renderAgentWorkspace(workspace, 180, 58));

    expect(output).toContain('ntfy token');
    expect(output).toContain('(empty)');
    expect(output).toContain('(secret)');
    expect(output).not.toContain('Change:');
    expect(output).not.toContain('->');
    expect(output).not.toContain('NTFY_TOKEN');
    expect(output).not.toContain('goodvibes://secrets');
  });

  test('suppresses internal command lines in onboarding result panes', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined, 'onboarding-context');
    workspace.lastActionResult = {
      kind: 'guidance',
      title: 'Context ready',
      detail: 'Context inspection is available from this setup page.',
      command: '/vibe status',
      safety: 'read-only',
    };

    const output = text(renderAgentWorkspace(workspace, 150, 58));

    expect(output).toContain('Result: Context ready');
    expect(output).not.toContain('Action Result');
    expect(output).not.toContain('Command:');
    expect(output).not.toContain('/vibe status');
  });

  test('keeps every Agent workspace category on the compact top-pane split', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);

    for (const category of workspace.categories) {
      const categoryWorkspace = new AgentWorkspace();
      categoryWorkspace.open(commandContext(), () => undefined, category.id);
      const output = text(renderAgentWorkspace(categoryWorkspace, 132, 37));
      const lines = output.split('\n');
      // The controls' column header row starts the lower part of the panel.
      const contextSeparatorRow = lines.findIndex((line, index) => index > 2 && /(Setting|Option|Action|Result)\s{2,}(Default|Does)/.test(line));

      expect(contextSeparatorRow).toBeGreaterThan(0);
      expect(contextSeparatorRow).toBeLessThanOrEqual(24);
      expect(output).toContain(category.label);
      if (category.group === 'ONBOARDING') {
        // Every onboarding category uses the consistent Setting/Default/Current layout.
        expect(output).toContain('Setting');
        expect(output).toContain('Default');
        expect(output).toContain('Current');
        expect(output).not.toContain('Change:');
        expect(output).not.toContain('Does:');
      } else {
        expect(output).toContain('Action');
      }
    }
  });

  test('renders provider and model picker actions in account onboarding', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'account-model');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'provider-use');
    let output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Choose provider and model');
    expect(output).toContain('About: Open the shared provider/model picker for the main chat route.');
    expect(output).not.toContain('Change:');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'account-reasoning');
    output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Reasoning effort');
    expect(output).not.toContain('Change:');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'account-run-local-model-benchmark');
    output = text(renderAgentWorkspace(workspace, 132, 54));
    expect(output).toContain('Run a local model benchmark');
    expect(output).not.toContain('Change:');
  });

  test('renders support bundle actions in the host workspace when selected', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-support-bundle-export');
    const exportOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(exportOutput).toContain('Export support bundle');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-support-bundle-inspect');
    const inspectOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(inspectOutput).toContain('Inspect support bundle');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-support-bundle-import');
    const importOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(importOutput).toContain('Import support bundle');
  });

  test('renders provider subscription login forms in the setup workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'subscription-login-start');

    const actionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(actionOutput).toContain('Sign in to a provider');
    expect(actionOutput).toContain('About: Start one provider sign-in flow, save pending state, and return here.');
    expect(actionOutput).not.toContain('Change:');

    workspace.activateSelected();
    const editorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(editorOutput).toContain('Start Provider Subscription Login');
    expect(editorOutput).toContain('Provider *');
    workspace.moveEditorField(1);
    const browserOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(browserOutput).toContain('Start Provider Subscription Login');
    expect(browserOutput).toContain('Open browser');
    workspace.moveEditorField(1);
    const confirmOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(confirmOutput).toContain('Editing: Confirm (required)');
  });

  test('renders provider maintenance forms from workspace actions', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-provider-detail');
    const inspectActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(inspectActionOutput).toContain('Provider detail');

    workspace.activateSelected();
    const inspectEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(inspectEditorOutput).toContain('Inspect Provider');
    expect(inspectEditorOutput).toContain('Provider id *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-provider-routes');
    const routesActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(routesActionOutput).toContain('Provider routes');

    workspace.activateSelected();
    const routesEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(routesEditorOutput).toContain('Inspect Provider Routes');
    expect(routesEditorOutput).toContain('Provider id *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-provider-repair');
    const accountRepairActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(accountRepairActionOutput).toContain('Provider repair guidance');

    workspace.activateSelected();
    const accountRepairEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(accountRepairEditorOutput).toContain('Review Provider Account Repair');
    expect(accountRepairEditorOutput).toContain('Provider id *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'provider-add');
    const addActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(addActionOutput).toContain('Add a custom provider');
    expect(addActionOutput).toContain('About: Add one OpenAI-compatible provider for Agent model routing.');
    expect(addActionOutput).not.toContain('Change:');

    workspace.activateSelected();
    const addEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(addEditorOutput).toContain('Add Custom Provider');
    expect(addEditorOutput).toContain('Provider name *');
    workspace.moveEditorField(2);
    const addKeyOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(addKeyOutput).toContain('API key');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'account-model');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'provider-remove');
    const removeActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(removeActionOutput).toContain('Remove a custom provider');
    expect(removeActionOutput).toContain('About: Remove one custom provider config after confirmation.');
    expect(removeActionOutput).not.toContain('Change:');
  });

  test('renders auth trust subscription and voice bundle forms in the workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-auth-bundle-export');
    workspace.activateSelected();
    const authOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(authOutput).toContain('Export Auth Review Bundle');
    expect(authOutput).toContain('Output path *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-subscription-bundle-inspect');
    workspace.activateSelected();
    const subscriptionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(subscriptionOutput).toContain('Inspect Subscription Bundle');
    expect(subscriptionOutput).toContain('Bundle path *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'trust-bundle-export');
    workspace.activateSelected();
    const trustOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(trustOutput).toContain('Export Trust Bundle');
    expect(trustOutput).toContain('Confirm *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-voice-media');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'voice-enable');
    workspace.activateSelected();
    const voiceOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(voiceOutput).toContain('Enable Voice Interaction');
    expect(voiceOutput).toContain('Confirm *');
  });

  test('renders discovered behavior files as context onboarding actions', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-discovery');
    mkdirSync(join(root, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(root, '.goodvibes', 'agent', 'skills', 'daily-brief'), { recursive: true });
    mkdirSync(join(root, '.goodvibes', 'agent', 'routines'), { recursive: true });
    writeFileSync(join(root, 'VIBE.md'), 'Prefer direct, user-first operator handoffs.');
    writeFileSync(join(root, 'AGENTS.md'), 'Use visible project context before hidden assumptions.');
    writeFileSync(join(root, 'CLAUDE.md'), 'api_key=supersecretvalue\nDo not load this project secret.');
    writeFileSync(join(root, '.goodvibes', 'agent', 'personas', 'research.md'), [
      '---',
      'name: Research Operator',
      'description: Source-backed research posture.',
      '---',
      'Prefer checked sources and clear unknowns.',
    ].join('\n'));
    writeFileSync(join(root, '.goodvibes', 'agent', 'skills', 'daily-brief', 'SKILL.md'), [
      '---',
      'name: Daily Brief Skill',
      'description: Build a concise operator brief.',
      '---',
      'Review work plans, approvals, routines, and Agent Knowledge before summarizing.',
    ].join('\n'));
    writeFileSync(join(root, '.goodvibes', 'agent', 'routines', 'evening.md'), [
      '---',
      'name: Evening Review',
      'description: Review open work before shutdown.',
      '---',
      'Review work plan, approvals, routines, and Agent Knowledge status.',
    ].join('\n'));
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const context = {
      ...commandContext(),
      workspace: { shellPaths },
      session: { runtime: { provider: 'openai-subscriber', model: 'openai:gpt-5.5', sessionId: 'setup-discovery-session' } },
      platform: { configManager: { get: (key: string) => key === 'controlPlane.host' ? '127.0.0.1' : key === 'controlPlane.port' ? 3421 : undefined } },
    } as unknown as CommandContext;
    const workspace = new AgentWorkspace();
    workspace.open(context, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-context');

    const output = text(renderAgentWorkspace(workspace, 150, 62));

    expect(output).toContain('Context');
    expect(output).toContain('Create/import memory, personas, skills, routines, notes, and Knowledge.');
    expect(output).toContain('VIBE.md: 1 applied; 0 blocked; 0 truncated.');
    expect(output).toContain('Project context: 1 loaded; 1 blocked; 0 truncated.');
    expect(output).toContain('Context controls: prompt receipts, project files, one-file inspection, and VIBE.md review.');
    expect(output).toContain('Inspect VIBE.md');
    expect(output).toContain('Inspect project context');
    expect(output).toContain('Inspect one context file');
    expect(output).toContain('Profile from discovered files');
    expect(output).toContain('Import persona files');
    expect(output).toContain('Import skill files');
    expect(output).toContain('Import routine files');
    expect(output).toContain('Create starter memory');
    expect(output).toContain('Ingest URL');
    expect(output).not.toContain('/vibe status');
    expect(output).not.toContain('context action:"');
    expect(output).not.toContain('Command:');
    expect(output).not.toContain('Does:');
    expect(output).not.toContain('RECOMMENDED Agent profile -> Profiles');
    expect(output).not.toContain('RECOMMENDED Persona -> Personas');
    expect(output).not.toContain('Discovered Behavior Files');
    expect(output).not.toContain('default knowledge');
  });

  test('renders context onboarding actions for skills routines and knowledge', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-context');

    const expectSetupAction = (id: string, label: string) => {
      workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === id);
      const output = text(renderAgentWorkspace(workspace, 150, 58));
      expect(output).toContain(label);
      expect(output).not.toContain('/vibe status');
      expect(output).not.toContain('context action:"');
      expect(output).not.toContain('Command:');
      expect(output).not.toContain('Does:');
      expect(output).not.toContain('->');
    };

    expectSetupAction('context-vibe-status', 'Inspect VIBE.md');
    expectSetupAction('context-project-files', 'Inspect project context');
    expectSetupAction('context-project-file', 'Inspect one context file');
    expectSetupAction('context-prompt-context', 'Prompt context');
    expectSetupAction('context-create-skill', 'Create skill');
    expectSetupAction('context-create-routine', 'Create routine');
    expectSetupAction('context-knowledge-url', 'Ingest URL');
    expectSetupAction('context-knowledge-file', 'Ingest file');
    expect(text(renderAgentWorkspace(workspace, 150, 58))).toContain('Context controls: prompt receipts, project files, one-file inspection, and VIBE.md review.');
  });

  test('renders prompt receipt outcomes in the Local Context workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext({ includePromptReceipts: true }), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-context');

    const output = text(renderAgentWorkspace(workspace, 150, 66));

    expect(output).toContain('Prompt receipt timeline: 1 total; completed 0; errors 1; cancelled 0; pending 0.');
    expect(output).toContain('Latest prompt receipt: error turn turn-renderer-fail; 3 applied / 1 suppressed; 512 tokens; stop provider_error.');
    expect(output).toContain('Latest prompt receipt: promptctx-');
    expect(output).toContain('inspect it from Prompt context.');
    expect(output).toContain('Prompt receipt filter: show errors.');
    expect(output).toContain('openai-subscriber/openai:gpt-5.5');
    expect(output).toContain('2 segment(s), 3 active, 1 suppressed.');
    expect(output).toContain('Latest outcome detail: Provider rejected the test request.');
    expect(output).toContain('Prompt context controls stay read-only from this setup page.');
    expect(output).not.toContain('context action:"');
    expect(output).not.toContain('/vibe status');
    expect(output).not.toContain('cccccccccccccccc');
  });

  test('renders local persona posture in the memory workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'memory');

    const output = text(renderAgentWorkspace(workspace, 132, 54));

    expect(output).toContain('Memory: 1; prompt 1; queue 1; session 1.');
    expect(output).toContain('Notes: 0; skills 1/1; routines 1/1; personas 1.');
    expect(output).toContain('Learning curator: memory queue 1; note queue 0; setup gaps 3; injected review 4.');
    expect(output).toContain('Prompt plan');
    expect(output).toContain('score reviewed context');
    expect(output).toContain('Active persona: Research Analyst.');
    expect(output).toContain('Agent Memory: 1; selected Prefers concise operator briefings');
    expect(output).toContain('Create memory');
    expect(output).toContain('Search memory');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-promote');
    const maintenanceOutput = text(renderAgentWorkspace(workspace, 132, 44));

    expect(maintenanceOutput).toContain('Edit selected memory');
    expect(maintenanceOutput).toContain('Learning curator');
    expect(maintenanceOutput).toContain('Promote memory');
    expect(maintenanceOutput).toContain('Export memory bundle');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-handoff-inspect');
    const handoffOutput = text(renderAgentWorkspace(workspace, 132, 44));

    expect(handoffOutput).toContain('Inspect handoff bundle');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'memory-vector-rebuild');
    const vectorOutput = text(renderAgentWorkspace(workspace, 132, 44));

    expect(vectorOutput).toContain('Rebuild vector index');
  });

  test('renders in-workspace local library editor controls', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'personas');
    const personasOutput = text(renderAgentWorkspace(workspace, 132, 48));
    const normalizedPersonasOutput = personasOutput.replace(/\s+/g, ' ');
    expect(normalizedPersonasOutput).toContain('VIBE.md: 0 applied; 0 blocked; 0 truncated.');
    expect(normalizedPersonasOutput).toContain('VIBE.md is personality; project context files are separate workspace instructions.');
    expect(normalizedPersonasOutput).toContain('Personas shape the serial main-conversation assistant.');
    expect(normalizedPersonasOutput).toContain('Persona Library: 1; selected Research Analyst');
    expect(normalizedPersonasOutput).not.toContain('not separate workers');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-search');
    workspace.activateSelected();
    const personaSearchOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(personaSearchOutput).toContain('Search Personas');
    expect(personaSearchOutput).toContain('Search query');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'personas-show');
    workspace.activateSelected();
    const personaShowOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(personaShowOutput).toContain('Show Persona');
    expect(personaShowOutput).toContain('Persona id *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-search');
    workspace.activateSelected();
    const skillSearchOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(skillSearchOutput).toContain('Search Skills');
    expect(skillSearchOutput).toContain('Search query');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-show');
    workspace.activateSelected();
    const skillShowOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(skillShowOutput).toContain('Show Skill');
    expect(skillShowOutput).toContain('Skill id *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-create');
    workspace.activateSelected();

    const output = text(renderAgentWorkspace(workspace, 132, 48));

    expect(output).toContain('Create Skill');
    expect(output).toContain('Name *');
    expect(output).toContain('more field(s) below');
    workspace.moveEditorField(2);
    const procedureOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(procedureOutput).toContain('Procedure *');
    expect(output).toContain('Enter next/save');
    expect(output).toContain('Esc cancel');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-search');
    workspace.activateSelected();
    const routineSearchOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(routineSearchOutput).toContain('Search Routines');
    expect(routineSearchOutput).toContain('Search query');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-show');
    workspace.activateSelected();
    const routineShowOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(routineShowOutput).toContain('Show Routine');
    expect(routineShowOutput).toContain('Routine id *');
  });

  test('renders local skill bundles in the skills workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');

    const output = text(renderAgentWorkspace(workspace, 132, 52));

    expect(output).toContain('Skills: 1; enabled: 1; bundles: 1; enabled bundles: 1; active skills: 1');
    expect(output).toContain('Create bundle');
    expect(output).toContain('Skill Bundles: 1; selected Operator Pack');
    expect(output).toContain('Skill Library: 1; selected Briefing');
    expect(output).toContain('needs 1/1');
    expect(output).toContain('Missing setup: env:GOODVIBES_AGENT_TEST_MISSING_TOKEN');
  });

  test('renders skill bundle lifecycle forms in the skills workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-update-bundle');
    workspace.activateSelected();
    const updateOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(updateOutput).toContain('Update Skill Bundle');
    expect(updateOutput).toContain('Bundle id *');
    workspace.moveEditorField(3);
    const updateSkillsOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(updateSkillsOutput).toContain('Skill ids');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-stale-bundle');
    workspace.activateSelected();
    const staleOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(staleOutput).toContain('Mark Skill Bundle Stale');
    expect(staleOutput).toContain('Reason *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-delete-bundle');
    workspace.activateSelected();
    const deleteOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(deleteOutput).toContain('Delete Skill Bundle');
    expect(deleteOutput).toContain('Confirm *');
  });

  test('renders routine setup readiness in the routines workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'routines');

    const output = text(renderAgentWorkspace(workspace, 132, 52));

    expect(output).toContain('Routines: 1; enabled: 1');
    expect(output).toContain('Routine Library: 1; selected Daily Brief');
    expect(output).toContain('needs 1/1');
    expect(output).toContain('Missing setup: env:GOODVIBES_AGENT_TEST_MISSING_ROUTINE_TOKEN');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'routines-receipt');
    const receiptActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(receiptActionOutput).toContain('Show promotion receipt');

    workspace.activateSelected();
    const receiptEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(receiptEditorOutput).toContain('Show Routine Promotion Receipt');
    expect(receiptEditorOutput).toContain('Receipt id *');
  });

  test('renders Agent Knowledge ingest and review workflow without default knowledge fallback', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-ingest-url');

    const output = text(renderAgentWorkspace(workspace, 132, 48));

    expect(output).toContain('Search Agent knowledge');
    expect(output).toContain('Ingest URL');
    expect(output).toContain('Import URL list');
    expect(output).toContain('Import bookmarks');
    // Knowledge actions all fit at height 38, no overflow indicator expected
    expect(output).not.toContain('/api/knowledge');
    expect(output).not.toContain('non-Agent product setup');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-review-issue');
    const reviewOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(reviewOutput).toContain('Review issue');
    expect(reviewOutput).not.toContain('/api/knowledge');
  });

  test('renders Agent Knowledge query forms with focused input fields', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-search');
    workspace.activateSelected();
    const searchOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(searchOutput).toContain('Search Agent Knowledge');
    expect(searchOutput).toContain('Search query *');
    expect(searchOutput).toContain('Results come from Agent-owned sources only');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-ask');
    workspace.activateSelected();
    const askOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(askOutput).toContain('Ask Agent Knowledge');
    expect(askOutput).toContain('Question *');
    expect(askOutput).toContain('fails closed instead of using');
  });

  test('renders Agent Knowledge maintenance forms from the workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-review-issue');
    workspace.activateSelected();
    const reviewOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(reviewOutput).toContain('Review Agent Knowledge Issue');
    expect(reviewOutput).toContain('Issue id *');
    expect(reviewOutput).toContain('Action *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-packet');
    workspace.activateSelected();
    const packetOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(packetOutput).toContain('Build Prompt Packet');
    expect(packetOutput).toContain('Task *');
    expect(packetOutput).toContain('Scopes');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-consolidate');
    workspace.activateSelected();
    const consolidateOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(consolidateOutput).toContain('Consolidate Agent Knowledge');
    expect(consolidateOutput).toContain('Confirm *');
  });

  test('renders bookmark media and skill bundle command forms with concrete fields', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-import-bookmarks');
    workspace.activateSelected();
    const bookmarkOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(bookmarkOutput).toContain('Import Bookmarks into Agent Knowledge');
    expect(bookmarkOutput).toContain('Bookmark export path *');
    expect(bookmarkOutput).toContain('Confirm *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-voice-media');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'image-attach');
    workspace.activateSelected();
    const imageOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(imageOutput).toContain('Attach Image Input');
    expect(imageOutput).toContain('Image path *');
    expect(imageOutput).toContain('Prompt');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'skills');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'skills-create-bundle');
    workspace.activateSelected();
    const bundleOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(bundleOutput).toContain('Create Skill Bundle');
    expect(bundleOutput).toContain('Bundle name *');
    workspace.moveEditorField(2);
    const bundleSkillsOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(bundleSkillsOutput).toContain('Skill ids *');
  });

  test('renders Agent Knowledge URL-list and reindex forms with confirmation fields', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'knowledge');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-import-urls');
    workspace.activateSelected();
    const urlListOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(urlListOutput).toContain('Import URL List into Agent Knowledge');
    expect(urlListOutput).toContain('URL list path *');
    expect(urlListOutput).toContain('Allow private hosts');
    expect(urlListOutput).toContain('Confirm *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'knowledge-reindex');
    workspace.activateSelected();
    const reindexOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(reindexOutput).toContain('Reindex Agent Knowledge');
    expect(reindexOutput).toContain('Confirm *');
  });

  test('renders routine schedule promotion as an in-workspace form', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-promote-routine');
    workspace.activateSelected();

    const output = text(renderAgentWorkspace(workspace, 132, 54));

    expect(output).toContain('Promote Routine to Schedule');
    expect(output).toContain('Routine id *');
    expect(output).toContain('daily-brief');
    expect(output).toContain('Schedule value *');
    expect(output).toContain('more field(s) below');
    workspace.moveEditorField(5);
    const deliveryOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(deliveryOutput).toContain('Delivery channel');
    expect(deliveryOutput).toContain('more field(s) above');
    workspace.moveEditorField(2);
    const confirmOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(confirmOutput).toContain('Confirm *');
    expect(output).not.toContain('<routine-id>');
    expect(output).not.toContain('<expr>');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'schedule-receipt');
    const receiptActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(receiptActionOutput).toContain('Show receipt');

    workspace.activateSelected();
    const receiptEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(receiptEditorOutput).toContain('Show Schedule Receipt');
    expect(receiptEditorOutput).toContain('Receipt id *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'health-repair');
    const healthActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(healthActionOutput).toContain('Health repair guidance');

    workspace.activateSelected();
    const healthEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(healthEditorOutput).toContain('Show Health Repair Guidance');
    expect(healthEditorOutput).toContain('Domain *');
  });

  test('renders automation next action and local schedule receipt state', () => {
    const root = makeProjectTempDir('goodvibes-agent-workspace-schedule-receipts');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const routines = AgentRoutineRegistry.fromShellPaths(shellPaths);
    routines.create({
      name: 'Daily Brief',
      description: 'Summarize operator state.',
      steps: 'Review current daemon, tasks, approvals, and Agent Knowledge status first.',
      enabled: true,
    });
    routines.markReviewed('daily-brief');
    const receiptPath = routineScheduleReceiptStorePath(shellPaths);
    mkdirSync(dirname(receiptPath), { recursive: true });
    writeFileSync(receiptPath, `${JSON.stringify({
      version: 1,
      receipts: [
        {
          id: 'daily-brief-20260602',
          // Relative to now: the receipt store drops receipts older than 90 days.
          createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          routineId: 'daily-brief',
          routineName: 'Daily Brief',
          route: '/api/automation/schedules',
          method: 'automation.schedules.create',
          status: 'created',
          daemonBaseUrl: 'http://127.0.0.1:3421',
          scheduleId: 'schedule-1',
          scheduleStatus: 'enabled',
          scheduleName: 'Daily Brief',
          scheduleKind: 'cron',
          scheduleValue: '0 9 * * *',
          enabled: true,
          target: { kind: 'surface', surfaceKind: 'tui' },
          deliveryMode: 'surface',
        },
      ],
    }, null, 2)}\n`);
    const workspace = new AgentWorkspace();
    workspace.open({
      ...commandContext(),
      workspace: { shellPaths },
    } as unknown as CommandContext, () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'automation');

    const output = text(renderAgentWorkspace(workspace, 150, 54));

    expect(output).toContain('Automation: 1 schedule-ready routine(s); receipts 1.');
    expect(output).toContain('Next automation action: Reconcile schedules to compare local receipts with the connected host.');
    expect(output).toContain('Promotion receipts: 1; latest created daily-brief.');
    expect(output).toContain('Autonomy queue: review visible schedules, runs, receipts, and cancel routes first.');
    expect(output).toContain('Reminders and routine promotion require confirmation.');
  });

  test('renders voice media and browser tool setup posture', () => {
    const keys = ['ELEVENLABS_API_KEY', 'XI_API_KEY', 'FAL_KEY', 'FAL_API_KEY'] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]] as const));
    for (const key of keys) delete process.env[key];
    const workspace = new AgentWorkspace();
    try {
      workspace.open(liveCommandContext(), () => undefined);
      workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-voice-media');

      const output = text(renderAgentWorkspace(workspace, 132, 64));

      expect(output).toContain('Voice & Media');
      expect(output).toContain('Voice readiness');
      expect(output).toContain('Device capability map');
      expect(output).toContain('Speak a prompt');
      expect(output).toContain('Attach image input');
      expect(output).not.toContain('/remote list');
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test('renders Tools and MCP setup posture with confirmed add form', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');

    const output = text(renderAgentWorkspace(workspace, 132, 48));

    expect(output).toContain('Tools & MCP');
    expect(output).toContain('Server tool inventory');
    expect(output).toContain('Repair guidance');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mcp-tools-server');
    const toolsActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(toolsActionOutput).toContain('Server tool inventory');

    workspace.activateSelected();
    const toolsEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(toolsEditorOutput).toContain('Show MCP Server Tools');
    expect(toolsEditorOutput).toContain('Server name *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mcp-repair');
    const repairActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(repairActionOutput).toContain('Repair guidance');

    workspace.activateSelected();
    const repairEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(repairEditorOutput).toContain('Show MCP Repair Guidance');
    expect(repairEditorOutput).toContain('Server name *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mcp-add-server');
    workspace.activateSelected();
    const editorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(editorOutput).toContain('Add MCP Server');
    expect(editorOutput).toContain('Server name *');
    expect(editorOutput).toContain('Command *');
    workspace.moveEditorField(9);
    const confirmOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(confirmOutput).toContain('Confirm *');
  });

  test('renders secret setup forms without exposing raw secret field values', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'tools');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'secret-set');

    workspace.activateSelected();
    workspace.appendEditorText('OPENAI_API_KEY');
    workspace.submitEditorFieldOrForm();
    workspace.appendEditorText('sk-render-secret-value');
    const output = text(renderAgentWorkspace(workspace, 132, 54));

    expect(output).toContain('Store Secret Value');
    expect(output).toContain('Secret value *');
    expect(output).toContain('************');
    expect(output).not.toContain('sk-render-secret-value');
  });

  test('renders profile isolation and bundle workflow posture', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');

    const output = text(renderAgentWorkspace(workspace, 132, 48));

    expect(output).toContain('Profiles');
    expect(output).toContain('Local profiles: 1; starters 5; custom 0.');
    expect(output).toContain('Export starter template');
    expect(output).toContain('Import starter template');
    expect(output).toContain('Use as default profile');
    expect(output).not.toContain('/profilesync');
    expect(output).not.toContain('/setup transfer');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-clear-default');
    const clearOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(clearOutput).toContain('Clear default profile');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-delete');
    const deleteOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(deleteOutput).toContain('Delete Agent profile');
  });

  test('renders profile starter export and import forms with concrete fields', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'profiles');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-export');
    workspace.activateSelected();
    const exportOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(exportOutput).toContain('Export Agent Starter Template');
    expect(exportOutput).toContain('Starter id *');
    expect(exportOutput).toContain('Output path *');
    workspace.moveEditorField(2);
    const exportConfirmOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(exportConfirmOutput).toContain('Confirm *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-import');
    workspace.activateSelected();
    const importOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(importOutput).toContain('Import Agent Starter Template');
    expect(importOutput).toContain('Template path *');
    expect(importOutput).toContain('Confirm *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'runtime-profile-template-show');
    workspace.activateSelected();
    const previewOutput = text(renderAgentWorkspace(workspace, 132, 48));
    expect(previewOutput).toContain('Preview Agent Starter Template');
    expect(previewOutput).toContain('Starter id *');
  });

  test('renders channel onboarding and delivery safety posture', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    // Scroll to channel-show so editor actions are visible in the rendered output
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-show');

    const output = text(renderAgentWorkspace(workspace, 132, 54));

    expect(output).toContain('Messaging');
    expect(output).toContain('Check a channel');
    expect(output).toContain('Diagnose a channel');
    expect(output).toContain('Channel setup guide');
    expect(output).toContain('Send a message');
    expect(output).toContain('Send a notification');
    expect(output).not.toContain('SLACK_BOT_TOKEN');
    expect(output).not.toContain('TELEGRAM_BOT_TOKEN');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'channel-setup');
    const setupOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(setupOutput).toContain('Channel setup guide');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'notification-clear-webhooks');
    const notificationOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(notificationOutput).toContain('Clear notification targets');
  });

  test('renders action feedback and refresh affordance', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');
    workspace.lastActionResult = {
      kind: 'guidance',
      title: 'Autonomy queue',
      detail: 'Inspecting visible host-task, approval, automation, schedule, routine, and delegation queue cards.',
      safety: 'read-only',
    };

    // Height 36 (was 34): the Work & Approvals category gained a "CI watches"
    // row, which pushed the Action Result panel below a 34-row viewport. This
    // test is about feedback + refresh affordance rendering, not the exact
    // viewport budget; the sibling render tests in this file use 44.
    const output = text(renderAgentWorkspace(workspace, 132, 46));

    expect(output).toContain('Action Result');
    expect(output).toContain('Autonomy queue');
    expect(output).toContain('R  refresh');
  });

  test('renders build delegation form as a confirmed TUI workflow', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'delegate-task');
    workspace.activateSelected();

    const output = text(renderAgentWorkspace(workspace, 132, 68));

    expect(output).toContain('Delegate Build Work to GoodVibes TUI');
    expect(output).toContain('Original task *');
    expect(output).toContain('Why delegate');
    expect(output).toContain('Success criteria');
    expect(output).toContain('Workspace hint');
    expect(output).toContain('Priority');
    // The rest of the form is reachable, and the window says how much is below.
    expect(output).toMatch(/\d+ more field\(s\) below/);
    expect(output).toContain('editing delegate-task');
  });

  test('renders work and approvals actions in the TUI workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'work');

    const output = text(renderAgentWorkspace(workspace, 132, 54));

    expect(output).toContain('Process supervision: available; 0 tracked; 0 running; 0 completed.');
    expect(output).toContain('Process parity: stdin not-yet-supported; PTY not-yet-supported; sudo foreground-only.');
    expect(output).toContain('Process routes: execution / capabilities / process monitor / live tail.');
    expect(output).toContain('Background processes');
    expect(output).toContain('Process capabilities');
    expect(output).toContain('Autonomy queue');
    expect(output).toContain('Filter host tasks');
    expect(output).toContain('Inspect host task');
    expect(output).toContain('Review approval class');

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'task-show');
    const workPlanDetailOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(workPlanDetailOutput).toContain('Inspect host task');

    workspace.activateSelected();
    const taskEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(taskEditorOutput).toContain('Inspect Host Task');
    expect(taskEditorOutput).toContain('Task id *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'approval-review');
    const approvalActionOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(approvalActionOutput).toContain('Review approval class');

    workspace.activateSelected();
    const approvalEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(approvalEditorOutput).toContain('Review Approval Class');
    expect(approvalEditorOutput).toContain('Approval kind *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'tasks-filter');
    const taskFilterOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(taskFilterOutput).toContain('Filter host tasks');

    workspace.activateSelected();
    const taskFilterEditorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(taskFilterEditorOutput).toContain('Filter Host Tasks');
    expect(taskFilterEditorOutput).toContain('Status or kind');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'task-show');
    const taskOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(taskOutput).toContain('Inspect host task');
    expect(taskOutput).toContain('Show task output');

    workspace.activateSelected();
    const editorOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(editorOutput).toContain('Inspect Host Task');
    expect(editorOutput).toContain('Task id *');
  });

  test('renders session continuity and interaction mode forms in the workspace', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'mode-preset');
    workspace.activateSelected();
    const modeOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(modeOutput).toContain('Set Interaction Mode');
    expect(modeOutput).toContain('Preset *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'conversation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-export-current');
    workspace.activateSelected();
    const exportOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(exportOutput).toContain('Export Conversation');
    expect(exportOutput).toContain('Output path *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-controls-find');
    workspace.activateSelected();
    const findOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(findOutput).toContain('Find Transcript Text');
    expect(findOutput).toContain('Search query *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-load');
    workspace.activateSelected();
    const loadOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(loadOutput).toContain('Load Session');
    expect(loadOutput).toContain('Session name *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-rename');
    workspace.activateSelected();
    const renameOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(renameOutput).toContain('Rename Current Session');
    expect(renameOutput).toContain('New session name *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-fork');
    workspace.activateSelected();
    const forkOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(forkOutput).toContain('Fork Current Session');
    expect(forkOutput).toContain('Fork name');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-resume');
    workspace.activateSelected();
    const resumeOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(resumeOutput).toContain('Resume Saved Session');
    expect(resumeOutput).toContain('Session id or name *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-session-info');
    workspace.activateSelected();
    const infoOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(infoOutput).toContain('Inspect Saved Session');
    expect(infoOutput).toContain('Session id or name *');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'host');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'host-session-graph');
    workspace.activateSelected();
    const graphOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(graphOutput).toContain('Inspect Session Graph');
    expect(graphOutput).toContain('Session id');

    workspace.cancelLocalEditor();
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'conversation');
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-session-export');
    workspace.activateSelected();
    const savedExportOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(savedExportOutput).toContain('Export Saved Session');
    expect(savedExportOutput).toContain('Format *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-session-search');
    workspace.activateSelected();
    const searchOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(searchOutput).toContain('Search Saved Sessions');
    expect(searchOutput).toContain('Search query *');

    workspace.cancelLocalEditor();
    workspace.selectedActionIndex = workspace.actions.findIndex((action) => action.id === 'conversation-session-delete');
    workspace.activateSelected();
    const deleteOutput = text(renderAgentWorkspace(workspace, 132, 54));
    expect(deleteOutput).toContain('Delete Saved Session');
    expect(deleteOutput).toContain('Confirm *');
  });

  test('setupOverviewLines never emits release-engineering jargon in the setup category', () => {
    const jargonPatterns: Array<[string, RegExp | string]> = [
      ['smoke', /\bsmoke\b/i],
      ['receipt', /\breceipt\b/i],
      ['receipt gaps / durable', /receipt gaps|durable/i],
      ['closeout', /closeout/i],
      ['schema', /\bschema\b/i],
      ['checkpoint', /Setup checkpoint:/i],
      ['repeated blocker', /Repeated blocker:/i],
      ['schema status', /schema status/i],
      ['publication guarantee', /publication guarantee/i],
      ['event cursor', /event cursor/i],
      ['wizard step count', /Setup wizard:/i],
      ['action: syntax', /(action|mode|setupItemId):"/],
      ['Wizard next', /Wizard next:/i],
      ['Setup closeout', /Setup closeout:/i],
    ];
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    const output = text(renderAgentWorkspace(workspace, 132, 60));

    for (const [label, pattern] of jargonPatterns) {
      expect(output).not.toMatch(pattern);
      if (output.match(pattern)) {
        throw new Error(`Jargon guard failed for "${label}": pattern ${pattern} matched in setup output`);
      }
    }
  });

  test('channels guide next-action never leaks userRoute tool-call syntax', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    const output = text(renderAgentWorkspace(workspace, 132, 54));

    // userRoute strings look like "/channels show telegram" or tool-call syntax, strip entirely, only label shown
    expect(output).not.toMatch(/Next:.*\/channels show/);
    expect(output).not.toMatch(/Next:.*->/);
    expect(output).not.toMatch(/Next:.*action:"/);
    expect(output).not.toMatch(/Next:.*mode:"/);
    // No setup overview 'Next:' line on channel pages, only on category.id === 'setup'
  });

  test('onboarding pages render the consistent Setting/Default/Current layout', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 60));

    // 3-column header on every onboarding page
    expect(output).toContain('Setting');
    expect(output).toContain('Default');
    expect(output).toContain('Current');

    // Action labels appear in the Setting column
    expect(output).toContain('Import GoodVibes settings');
    expect(output).toContain('Choose main model');
    expect(output).toContain('Sign in to a provider');

    // The footer finish row is always visible
    expect(output).toContain('Finish setup');
  });

  test('finish row is sticky on every onboarding category', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);

    // Category 1: setup (Start)
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');
    const setupOutput = text(renderAgentWorkspace(workspace, 132, 60));
    expect(setupOutput).toContain('Finish setup');

    // Category 2: onboarding-context (Local Context), different ONBOARDING category
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-context');
    const contextOutput = text(renderAgentWorkspace(workspace, 132, 60));
    expect(contextOutput).toContain('Finish setup');

    // Category 3: account-model (Model Routing)
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'account-model');
    const accountOutput = text(renderAgentWorkspace(workspace, 132, 60));
    expect(accountOutput).toContain('Finish setup');
  });

  test('left pane shows per-category readiness glyphs for onboarding categories', () => {
    const workspace = new AgentWorkspace();
    workspace.open(liveCommandContext(), () => undefined);
    // Navigate to setup category so the left pane is rendered at that position
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'setup');

    const output = text(renderAgentWorkspace(workspace, 132, 60));

    // setup category covers runtime + connected-host-auth + provider-model, all ready in liveCommandContext
    // So the Start row should show the success glyph ✓
    // We look for the left pane: the Start label with a readiness marker
    expect(output).toContain('✓'); // ✓ GLYPHS.status.success, at least one ready category

    // onboarding-context covers agent-knowledge (recommended), should show attention marker !
    // Navigate to a different category so onboarding-context row is still visible in the left pane
    workspace.selectedCategoryIndex = workspace.categories.findIndex((category) => category.id === 'onboarding-channels');
    const output2 = text(renderAgentWorkspace(workspace, 132, 60));
    // The left pane includes ONBOARDING group header and category rows
    // Group headers are the kit's lowercase ✦ headers.
    expect(output2).toContain('✦ onboarding');
    // Both success (✓) and attention (!) markers must be present: setup maps to all-ready
    // critical items, and onboarding-context maps to agent-knowledge which is recommended.
    expect(output2).toContain('✓');
    expect(output2).toContain('!');
  });
});

describe('a long action result is reachable, never clipped', () => {
  function longResultWorkspace(lines: number) {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);
    workspace.lastActionResult = {
      kind: 'refreshed',
      title: 'Google connection',
      detail: Array.from({ length: lines }, (_, index) => `report line ${String(index)}`).join('\n'),
      safety: 'read-only',
    };
    return workspace;
  }

  test('the first lines are shown with a way to reach the rest', () => {
    // The ruling this guards: no surface ships too small for its complete text.
    // The pane cannot grow, so it must scroll, and it must say that it can.
    const workspace = longResultWorkspace(60);

    const output = text(renderAgentWorkspace(workspace, 120, 60));

    expect(output).toContain('report line 0');
    expect(output).toContain('more line(s) below');
    expect(output).toContain('PageDown');
  });

  test('scrolling reaches lines the first screen could not show', () => {
    const workspace = longResultWorkspace(60);
    const before = text(renderAgentWorkspace(workspace, 120, 60));
    expect(before).not.toContain('report line 59');

    // Page down until the end is reached; the offset clamps, so this terminates.
    for (let page = 0; page < 40; page += 1) {
      workspace.scrollActionResult(5);
      renderAgentWorkspace(workspace, 120, 60);
    }
    const after = text(renderAgentWorkspace(workspace, 120, 60));

    expect(after).toContain('report line 59');
    expect(after).toContain('more line(s) above');
    expect(after).toContain('PageUp');
  });

  test('a new result rewinds the scroll to its first line', () => {
    const workspace = longResultWorkspace(60);
    for (let page = 0; page < 6; page += 1) {
      workspace.scrollActionResult(5);
      renderAgentWorkspace(workspace, 120, 60);
    }
    expect(workspace.resultScroll).toBeGreaterThan(0);

    workspace.lastActionResult = {
      kind: 'refreshed',
      title: 'Another result',
      detail: 'A short answer.',
      safety: 'safe',
    };
    const output = text(renderAgentWorkspace(workspace, 120, 60));

    expect(workspace.resultScroll).toBe(0);
    expect(output).toContain('A short answer.');
  });

  test('the action list keeps room even when the result is enormous', () => {
    const workspace = longResultWorkspace(500);

    const output = text(renderAgentWorkspace(workspace, 120, 60));

    // The person must still be able to see and pick the next card.
    expect(output).toContain('Just start typing');
  });

  test('a result that fits carries no scroll markers', () => {
    const workspace = new AgentWorkspace();
    workspace.open(commandContext(), () => undefined);
    workspace.lastActionResult = {
      kind: 'refreshed',
      title: 'Google connection',
      detail: 'Gmail: not connected.',
      safety: 'read-only',
    };

    const output = text(renderAgentWorkspace(workspace, 120, 60));

    expect(output).not.toContain('more line(s) below');
    expect(output).not.toContain('more line(s) above');
  });
});
