import { describe, test, expect } from 'bun:test';
import { createAgentTool, AgentManager, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { AgentMessageBus, WrfcController } from '@goodvibes-jev/engine/sdk/platform/agents';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { join } from 'node:path';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import {
  AGENT_ANALYZE_NETWORK_DENIAL_MESSAGE,
  AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES,
  AGENT_CHANNEL_ACTION_DENIAL_MESSAGE,
  AGENT_CONTROL_MUTATION_DENIAL_MESSAGE,
  AGENT_CONTEXT_TOOL_COMPATIBILITY_MODES,
  AGENT_DURABLE_WORKFLOW_MUTATION_DENIAL_MESSAGE,
  AGENT_EXEC_BACKGROUND_DENIAL_MESSAGE,
  AGENT_FETCH_NETWORK_MUTATION_DENIAL_MESSAGE,
  AGENT_FIND_POLICY_DENIAL_MESSAGE,
  AGENT_INSPECT_WRITE_DENIAL_MESSAGE,
  AGENT_MAX_READ_FILES,
  AGENT_MAX_READ_IMAGE_SIZE_BYTES,
  AGENT_MCP_SECURITY_MUTATION_DENIAL_MESSAGE,
  AGENT_MAIN_CONVERSATION_TOOL_DENIAL_MESSAGE,
  AGENT_LOCAL_SPAWN_DENIAL_MESSAGE,
  AGENT_READ_IMAGE_MODES,
  AGENT_READ_ONLY_ANALYZE_TOOL_MODES,
  AGENT_READ_ONLY_CHANNEL_TOOL_MODES,
  AGENT_READ_ONLY_CONTROL_TOOL_MODES,
  AGENT_READ_ONLY_FETCH_METHODS,
  AGENT_READ_ONLY_FIND_OUTPUT_FORMATS,
  AGENT_READ_ONLY_MCP_TOOL_MODES,
  AGENT_READ_ONLY_PACKET_TOOL_MODES,
  AGENT_READ_ONLY_QUERY_TOOL_MODES,
  AGENT_READ_ONLY_REGISTRY_TOOL_MODES,
  AGENT_READ_ONLY_REMOTE_TOOL_MODES,
  AGENT_READ_ONLY_STATE_ANALYTICS_ACTIONS,
  AGENT_READ_ONLY_STATE_HOOK_ACTIONS,
  AGENT_READ_ONLY_STATE_MEMORY_ACTIONS,
  AGENT_READ_ONLY_STATE_MODE_ACTIONS,
  AGENT_READ_ONLY_STATE_TOOL_MODES,
  AGENT_READ_ONLY_TASK_TOOL_MODES,
  AGENT_READ_ONLY_TEAM_TOOL_MODES,
  AGENT_READ_ONLY_TOOL_MODES,
  AGENT_READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS,
  AGENT_READ_ONLY_WEB_SEARCH_VERBOSITIES,
  AGENT_READ_ONLY_WORKLIST_TOOL_MODES,
  AGENT_READ_POLICY_DENIAL_MESSAGE,
  AGENT_REMOTE_MUTATION_DENIAL_MESSAGE,
  AGENT_REGISTRY_CONTENT_DENIAL_MESSAGE,
  AGENT_SETTINGS_CONFIRMATION_PROPERTY,
  AGENT_SETTINGS_TOOL_DESCRIPTION_TEXT,
  AGENT_STATE_MUTATION_DENIAL_MESSAGE,
  AGENT_WEB_SEARCH_POLICY_DENIAL_MESSAGE,
  installAgentToolPolicyGuard,
  normalizeAgentToolInvocationForAgentPolicy,
  wrapAgentToolForAgentPolicy,
} from '../../tools/agent-tool-policy-guard.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgentHarness(options: { readonly guarded?: boolean } = {}) {
  const configDir = makeProjectTempDir(`gv-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const configManager = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir });
  const runtimeBus = new RuntimeEventBus();
  const messageBus = new AgentMessageBus();
  const manager = new AgentManager({
    messageBus,
    configManager,
  });
  manager.setRuntimeBus(runtimeBus);
  const wrfcController = new WrfcController(runtimeBus, messageBus, {
    agentManager: manager,
    configManager,
    projectRoot: configDir,
    fixWorkstreamRunner: { run: async () => ({ status: 'failed', reason: 'agent tool tests run no fix cycles', structured: 'tasks-failed' }) },
  });
  manager.setWrfcController(wrfcController);
  const agentTool = createAgentTool({
    manager,
    messageBus,
    configManager,
  });
  if (options.guarded) wrapAgentToolForAgentPolicy(agentTool);
  return { agentTool, manager, messageBus, configManager };
}

function makeNoopTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} test tool`,
      parameters: { type: 'object', properties: {} },
      sideEffects: ['write_fs'],
    },
    execute: async () => ({ success: true, output: `${name} executed` }),
  };
}

function makeModeTool(name: string, modes: readonly string[]): Tool {
  return {
    definition: {
      name,
      description: `${name} mode test tool`,
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: [...modes] },
          createIfMissing: { type: 'boolean' },
          actionId: { type: 'string' },
          toolId: { type: 'string' },
          accountAction: { type: 'string' },
          actorId: { type: 'string' },
        },
      },
      sideEffects: ['state', 'network'],
    },
    execute: async () => ({ success: true, output: `${name} executed` }),
  };
}

function makeFetchModeTool(): Tool {
  return {
    definition: {
      name: 'fetch',
      description: 'fetch test tool',
      parameters: {
        type: 'object',
        properties: {
          urls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string' },
                method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] },
                headers: { type: 'object' },
                body: { type: 'string' },
                body_base64: { type: 'string' },
                body_type: { type: 'string' },
                body_data: { type: 'object' },
                retry_on_auth: { type: 'boolean' },
                service: { type: 'string' },
                auth: { type: 'object' },
              },
            },
          },
          parallel: { type: 'boolean' },
          sanitize_mode: { type: 'string', enum: ['none', 'safe-text', 'strict'] },
          trusted_hosts: { type: 'array', items: { type: 'string' } },
        },
      },
      sideEffects: ['network'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeReadTool(): Tool {
  return {
    definition: {
      name: 'read',
      description: 'read test tool',
      parameters: {
        type: 'object',
        properties: {
          files: {
            type: 'array',
            maxItems: 50,
            items: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                extract: { type: 'string', enum: ['content', 'outline', 'symbols', 'ast', 'lines'] },
                image_mode: { type: 'string', enum: ['default', 'unoptimized', 'metadata-only', 'thumbnail-only'] },
              },
            },
          },
          extract: { type: 'string', enum: ['content', 'outline', 'symbols', 'ast', 'lines'] },
          image_mode: { type: 'string', enum: ['default', 'unoptimized', 'metadata-only', 'thumbnail-only'] },
          max_image_size: { type: 'integer', minimum: 1 },
        },
      },
      sideEffects: ['read_fs'],
      concurrency: 'parallel',
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeStateModeTool(): Tool {
  return {
    definition: {
      name: 'state',
      description: 'state test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['get', 'set', 'list', 'clear', 'budget', 'context', 'memory', 'telemetry', 'hooks', 'mode', 'analytics'],
          },
          keys: { type: 'array' },
          values: { type: 'object' },
          clearKeys: { type: 'array' },
          memoryAction: { type: 'string', enum: ['list', 'get', 'set'] },
          memoryKey: { type: 'string' },
          memoryValue: { type: 'string' },
          hookAction: { type: 'string', enum: ['list', 'enable', 'disable', 'add', 'remove'] },
          hookName: { type: 'string' },
          hookDefinition: { type: 'object' },
          modeAction: { type: 'string', enum: ['get', 'list', 'set'] },
          modeName: { type: 'string' },
          analyticsAction: { type: 'string', enum: ['summary', 'query', 'dashboard', 'record', 'sync', 'export'] },
          analyticsTool: { type: 'string' },
          analyticsArgs: { type: 'object' },
          analyticsResult: { type: 'object' },
          analyticsDuration: { type: 'number' },
          analyticsTokens: { type: 'number' },
          analyticsFormat: { type: 'string' },
        },
      },
      sideEffects: ['state'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeSettingsTool(): Tool {
  return {
    definition: {
      name: 'goodvibes_settings',
      description: 'settings mutation test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['set', 'reset'] },
          key: { type: 'string' },
          value: { type: 'string' },
          confirm: { type: 'boolean' },
        },
      },
      sideEffects: ['state'],
    },
    execute: async () => ({ success: true, output: 'settings mutated' }),
  };
}

function makeContextTool(): Tool {
  return {
    definition: {
      name: 'goodvibes_context',
      description: 'runtime context test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['summary', 'knowledge', ['home', 'graph'].join('')] },
          includeAllSpaces: { type: 'boolean' },
          knowledgeSpaceId: { type: 'string' },
        },
      },
      sideEffects: ['read_fs'],
    },
    execute: async () => ({ success: true, output: 'copied context exposed' }),
  };
}

function makeHarnessAliasTargetTool(): Tool {
  return {
    definition: {
      name: 'agent_harness',
      description: 'harness alias target test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string' },
          query: { type: 'string' },
          target: { type: 'string' },
          includeParameters: { type: 'boolean' },
        },
      },
      sideEffects: ['state'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify({ received: args }) }),
  };
}

function makeInspectTool(): Tool {
  return {
    definition: {
      name: 'inspect',
      description: 'inspect test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['project', 'api', 'scaffold'] },
          projectRoot: { type: 'string' },
          moduleName: { type: 'string' },
          dryRun: { type: 'boolean' },
        },
      },
      sideEffects: ['read_fs'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeControlTool(): Tool {
  return {
    definition: {
      name: 'control',
      description: 'control test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['commands', 'panels', 'subscriptions', 'sandbox-presets', 'restart-daemon'] },
        },
      },
      sideEffects: ['state'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeAnalyzeTool(): Tool {
  return {
    definition: {
      name: 'analyze',
      description: 'analyze test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: [
              'impact',
              'dependencies',
              'dead_code',
              'security',
              'coverage',
              'bundle',
              'preview',
              'diff',
              'surface',
              'breaking',
              'semantic_diff',
              'upgrade',
              'permissions',
              'env_audit',
              'test_find',
            ],
          },
          packages: { type: 'array', items: { type: 'string' } },
        },
      },
      sideEffects: ['read_fs', 'network'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeRegistryTool(): Tool {
  return {
    definition: {
      name: 'registry',
      description: 'registry test tool',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['search', 'recommend', 'dependencies', 'preview', 'content'] },
          path: { type: 'string' },
          query: { type: 'string' },
        },
      },
      sideEffects: ['read_fs'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeWebSearchTool(): Tool {
  return {
    definition: {
      name: 'web_search',
      description: 'web search test tool',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          maxResults: { type: 'integer', maximum: 25 },
          verbosity: { type: 'string', enum: ['urls_only', 'titles', 'snippets', 'evidence', 'full'] },
          safeSearch: { type: 'string', enum: ['strict', 'moderate', 'off'] },
          includeEvidence: { type: 'boolean' },
          evidenceTopN: { type: 'integer', maximum: 10 },
          evidenceExtract: {
            type: 'string',
            enum: ['raw', 'text', 'json', 'markdown', 'readable', 'code_blocks', 'links', 'metadata', 'structured', 'tables', 'pdf', 'summary'],
          },
        },
      },
      sideEffects: ['network'],
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeFindTool(): Tool {
  return {
    definition: {
      name: 'find',
      description: 'find test tool',
      parameters: {
        type: 'object',
        properties: {
          queries: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                mode: { type: 'string', enum: ['files', 'content', 'symbols', 'references', 'structural'] },
                patterns: { type: 'array', items: { type: 'string' } },
                pattern: { type: 'string' },
                path: { type: 'string' },
                follow_symlinks: { type: 'boolean' },
                include_hidden: { type: 'boolean' },
                respect_gitignore: { type: 'boolean' },
              },
            },
          },
          output: {
            type: 'object',
            properties: {
              format: {
                type: 'string',
                enum: [
                  'count_only',
                  'files_only',
                  'locations',
                  'matches',
                  'context',
                  'with_stats',
                  'with_preview',
                  'signatures',
                  'full',
                ],
              },
              preview_lines: { type: 'integer' },
              max_results: { type: 'integer' },
            },
          },
          parallel: { type: 'boolean' },
        },
      },
      sideEffects: ['read_fs'],
      concurrency: 'parallel',
    },
    execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
  };
}

function makeDurableModeTool(name: string, modes: readonly string[], extraProperties: readonly string[]): Tool {
  const properties: Record<string, unknown> = {
    mode: { type: 'string', enum: [...modes] },
    view: { type: 'string' },
    taskId: { type: 'string' },
    teamId: { type: 'string' },
    worklistId: { type: 'string' },
    packetId: { type: 'string' },
    queryId: { type: 'string' },
  };
  for (const key of extraProperties) properties[key] = { type: 'string' };
  return {
    definition: {
      name,
      description: `${name} durable workflow test tool`,
      parameters: {
        type: 'object',
        properties,
      },
      sideEffects: ['workflow', 'state'],
    },
    execute: async () => ({ success: true, output: `${name} executed` }),
  };
}

function getRecordProperty(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function expectPresent<T>(value: T | null | undefined, description: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${description}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

describe('spawn mode', () => {

  test('Agent runtime guard allows visible local spawn work', async () => {
    const guarded = makeAgentHarness({ guarded: true });
    const result = await guarded.agentTool.execute({
      mode: 'spawn',
      task: 'Build the feature',
      template: 'engineer',
      reviewMode: 'none',
      dangerously_disable_wrfc: true,
    });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output ?? '{}') as { readonly task?: string; readonly template?: string };
    expect(payload.task).toBe('Build the feature');
    expect(payload.template).toBe('engineer');
    expect(guarded.manager.list()).toHaveLength(1);
  });

  test('Agent runtime guard allows visible batch-spawn fanout', async () => {
    const guarded = makeAgentHarness({ guarded: true });
    const result = await guarded.agentTool.execute({
      mode: 'batch-spawn',
      reviewMode: 'none',
      dangerously_disable_wrfc: true,
      tasks: [
        { task: 'Build the API adapter', template: 'engineer', reviewMode: 'none', dangerously_disable_wrfc: true },
        { task: 'Build the CLI adapter', template: 'engineer', reviewMode: 'none', dangerously_disable_wrfc: true },
      ],
    });

    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output ?? '{}') as { readonly agents?: readonly unknown[] };
    expect(payload.agents).toHaveLength(2);
    expect(guarded.manager.list()).toHaveLength(2);
  });

  test('Agent runtime guard advertises visible autonomy modes', () => {
    const guarded = makeAgentHarness({ guarded: true });
    const mode = expectPresent(
      guarded.agentTool.definition.parameters.properties as Record<string, unknown> | undefined,
      'guarded agent schema properties',
    );
    expect(guarded.agentTool.definition.description).toContain('Visible local Agent orchestration');
    const modeProperty = expectPresent(
      getRecordProperty(mode, 'mode'),
      'guarded agent mode property',
    );
    const enumValues = modeProperty.enum;
    expect(enumValues).toEqual([...AGENT_READ_ONLY_TOOL_MODES]);
    expect(enumValues).toContain('spawn');
    expect(enumValues).toContain('batch-spawn');
    expect(enumValues).toContain('wrfc-chains');
    expect(enumValues).toContain('wrfc-history');
  });

  test('Agent runtime guard allows local agent cancellation mode', async () => {
    const guarded = makeAgentHarness({ guarded: true });
    const spawned = await guarded.agentTool.execute({ mode: 'spawn', task: 'Stuck task' });
    expect(spawned.success).toBe(true);
    const spawnedPayload = JSON.parse(spawned.output ?? '{}') as { readonly agentId?: string };
    const result = await guarded.agentTool.execute({
      mode: 'cancel',
      agentId: spawnedPayload.agentId,
    });

    expect(result.success).toBe(true);
    expect(guarded.manager.getStatus(spawnedPayload.agentId ?? '')?.status).toBe('cancelled');
  });

  test('Agent runtime guard leaves read-only agent inspection modes unchanged', () => {
    const normalized = normalizeAgentToolInvocationForAgentPolicy({
      mode: 'list',
      status: 'running',
    });

    expect(normalized).toEqual({
      mode: 'list',
      status: 'running',
    });
  });

  test('Agent runtime guard blocks direct coding mutation and local workflow tools', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    for (const name of AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES) registry.register(makeNoopTool(name));

    installAgentToolPolicyGuard(registry);

    for (const name of AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES) {
      const definition = registry.getToolDefinitions().find((tool) => tool.name === name);
      expect(definition?.description).toBe(`Blocked in GoodVibes Agent: ${name}.`);
      expect(definition?.sideEffects).toEqual([]);

      const result = await registry.execute(`call-${name}`, name, {});
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_MAIN_CONVERSATION_TOOL_DENIAL_MESSAGE);
      expect(result.callId).toBe(`call-${name}`);
    }
  });

  test('Agent runtime guard narrows exec to foreground serial commands', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeNoopTool('exec'));

    installAgentToolPolicyGuard(registry);

    const execDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'exec');
    expect(execDefinition?.description).toContain('foreground shell commands serially');
    const properties = execDefinition?.parameters.properties as Record<string, unknown>;
    expect(properties.parallel).toBeUndefined();
    expect(properties.file_ops).toBeUndefined();
    const commandsProperty = getRecordProperty(properties, 'commands');
    const itemSchema = commandsProperty ? getRecordProperty(commandsProperty, 'items') : undefined;
    const commandProperties = itemSchema ? getRecordProperty(itemSchema, 'properties') : undefined;
    expect(commandProperties?.background).toBeUndefined();

    const foreground = await registry.execute('call-exec-foreground', 'exec', {
      commands: [{ cmd: 'echo hello' }],
    });
    expect(foreground.success).toBe(true);
    expect(foreground.output).toBe('exec executed');

    const blockedInputs: ReadonlyArray<Record<string, unknown>> = [
      { commands: [{ cmd: 'sleep 100', background: true }] },
      { commands: [{ cmd: 'bg_list' }] },
      { commands: [{ cmd: 'bg_status process-1' }] },
      { commands: [{ cmd: 'long setup', until: { pattern: 'ready' } }] },
      { commands: [{ cmd: 'echo ok' }], parallel: true },
      { commands: [{ cmd: 'echo ok' }], file_ops: [{ op: 'delete', source: 'tmp.txt' }] },
    ];

    for (const [index, input] of blockedInputs.entries()) {
      const result = await registry.execute(`call-exec-blocked-${index}`, 'exec', input);
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_EXEC_BACKGROUND_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows remote build-host tool to read-only modes', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeModeTool('remote', ['create-pool', 'pools', 'assign', 'unassign', 'contracts', 'artifacts', 'review', 'import-artifact']));

    installAgentToolPolicyGuard(registry);

    const remoteDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'remote');
    expect(remoteDefinition?.description).toContain('Read-only remote build-host inspection');
    expect(remoteDefinition?.description).not.toContain('remote runner');
    const properties = remoteDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_REMOTE_TOOL_MODES]);

    for (const mode of AGENT_READ_ONLY_REMOTE_TOOL_MODES) {
      const result = await registry.execute(`call-remote-${mode}`, 'remote', { mode });
      expect(result.success).toBe(true);
    }

    const blockedModes = ['create-pool', 'assign', 'unassign', 'import-artifact'] as const;
    for (const mode of blockedModes) {
      const result = await registry.execute(`call-remote-blocked-${mode}`, 'remote', { mode });
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_REMOTE_MUTATION_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows channel tool to read-only inspection', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeModeTool('channel', [
      'accounts',
      'account_action',
      'directory',
      'resolve_target',
      'capabilities',
      'tools',
      'agent_tools',
      'run_tool',
      'actions',
      'run_action',
      'authorize',
    ]));

    installAgentToolPolicyGuard(registry);

    const channelDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'channel');
    expect(channelDefinition?.description).toContain('Read-only channel inspection');
    const properties = channelDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_CHANNEL_TOOL_MODES]);
    expect(properties.createIfMissing).toBeUndefined();
    expect(properties.actionId).toBeUndefined();
    expect(properties.toolId).toBeUndefined();

    for (const mode of AGENT_READ_ONLY_CHANNEL_TOOL_MODES) {
      const result = await registry.execute(`call-channel-${mode}`, 'channel', { mode });
      expect(result.success).toBe(true);
    }

    const blockedModes = ['account_action', 'run_tool', 'run_action', 'authorize'] as const;
    for (const mode of blockedModes) {
      const result = await registry.execute(`call-channel-blocked-${mode}`, 'channel', { mode });
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_CHANNEL_ACTION_DENIAL_MESSAGE);
    }

    const createTarget = await registry.execute('call-channel-create-target', 'channel', {
      mode: 'resolve_target',
      createIfMissing: true,
    });
    expect(createTarget.success).toBe(false);
    expect(createTarget.error).toBe(AGENT_CHANNEL_ACTION_DENIAL_MESSAGE);
  });

  test('Agent runtime guard narrows MCP tool to read-only security inspection', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeModeTool('mcp', [
      'servers',
      'tools',
      'schema',
      'resources',
      'security',
      'auth',
      'approve-quarantine',
      'set-trust',
      'set-role',
    ]));

    installAgentToolPolicyGuard(registry);

    const mcpDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'mcp');
    expect(mcpDefinition?.description).toContain('Read-only MCP inspection');
    const properties = mcpDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_MCP_TOOL_MODES]);

    for (const mode of AGENT_READ_ONLY_MCP_TOOL_MODES) {
      const result = await registry.execute(`call-mcp-${mode}`, 'mcp', { mode });
      expect(result.success).toBe(true);
    }

    const blockedModes = ['approve-quarantine', 'set-trust', 'set-role'] as const;
    for (const mode of blockedModes) {
      const result = await registry.execute(`call-mcp-blocked-${mode}`, 'mcp', { mode });
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_MCP_SECURITY_MUTATION_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows fetch to serial unauthenticated read-only HTTP', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeFetchModeTool());

    installAgentToolPolicyGuard(registry);

    const fetchDefinition = expectPresent(
      registry.getToolDefinitions().find((tool) => tool.name === 'fetch'),
      'fetch tool definition',
    );
    expect(fetchDefinition.description).toContain('serial, read-only HTTP requests');
    const properties = fetchDefinition.parameters.properties as Record<string, unknown>;
    expect(properties.parallel).toBeUndefined();
    expect(properties.trusted_hosts).toBeUndefined();
    const sanitizeModeProperty = getRecordProperty(properties, 'sanitize_mode');
    expect(sanitizeModeProperty?.enum).toEqual(['safe-text', 'strict']);

    const urlsProperty = getRecordProperty(properties, 'urls');
    const itemSchema = urlsProperty ? getRecordProperty(urlsProperty, 'items') : undefined;
    const urlProperties = itemSchema ? getRecordProperty(itemSchema, 'properties') : undefined;
    const fetchUrlProperties = expectPresent(urlProperties, 'fetch URL properties');
    const methodProperty = getRecordProperty(fetchUrlProperties, 'method');
    expect(methodProperty?.enum).toEqual([...AGENT_READ_ONLY_FETCH_METHODS]);
    expect(fetchUrlProperties.body).toBeUndefined();
    expect(fetchUrlProperties.headers).toBeUndefined();
    expect(fetchUrlProperties.auth).toBeUndefined();
    expect(fetchUrlProperties.service).toBeUndefined();

    for (const method of AGENT_READ_ONLY_FETCH_METHODS) {
      const result = await registry.execute(`call-fetch-${method}`, 'fetch', {
        urls: [{ url: 'https://example.com/', method }],
      });
      expect(result.success).toBe(true);
      const normalized = JSON.parse(result.output ?? '{}') as { readonly parallel?: boolean };
      expect(normalized.parallel).toBe(false);
    }

    const blockedInputs: ReadonlyArray<Record<string, unknown>> = [
      { urls: [{ url: 'https://example.com/', method: 'POST' }] },
      { urls: [{ url: 'https://example.com/', method: 'PUT' }] },
      { urls: [{ url: 'https://example.com/', method: 'PATCH' }] },
      { urls: [{ url: 'https://example.com/', method: 'DELETE' }] },
      { urls: [{ url: 'https://example.com/', body: 'payload' }] },
      { urls: [{ url: 'https://example.com/', headers: { authorization: 'Bearer secret' } }] },
      { urls: [{ url: 'https://example.com/', auth: { type: 'bearer', token: 'secret' } }] },
      { urls: [{ url: 'https://example.com/', service: 'private-api' }] },
      { urls: [{ url: 'https://example.com/' }], sanitize_mode: 'none' },
      { urls: [{ url: 'https://example.com/' }], trusted_hosts: ['example.com'] },
      { urls: [{ url: 'https://example.com/' }], parallel: true },
    ];

    for (const [index, input] of blockedInputs.entries()) {
      const result = await registry.execute(`call-fetch-blocked-${index}`, 'fetch', input);
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_FETCH_NETWORK_MUTATION_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows read to bounded non-secret project files', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeReadTool());

    installAgentToolPolicyGuard(registry);

    const readDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'read');
    expect(readDefinition?.description).toContain('ordinary non-secret project files');
    expect(readDefinition?.sideEffects).toEqual(['read_fs']);
    expect(readDefinition?.concurrency).toBe('serial');

    const properties = readDefinition?.parameters.properties as Record<string, unknown>;
    const files = getRecordProperty(properties, 'files');
    expect(files?.maxItems).toBe(AGENT_MAX_READ_FILES);
    const itemSchema = files ? getRecordProperty(files, 'items') : undefined;
    const fileProperties = itemSchema ? getRecordProperty(itemSchema, 'properties') : undefined;
    const fileImageMode = fileProperties ? getRecordProperty(fileProperties, 'image_mode') : undefined;
    const globalImageMode = getRecordProperty(properties, 'image_mode');
    const maxImageSize = getRecordProperty(properties, 'max_image_size');
    expect(fileImageMode?.enum).toEqual([...AGENT_READ_IMAGE_MODES]);
    expect(globalImageMode?.enum).toEqual([...AGENT_READ_IMAGE_MODES]);
    expect(maxImageSize?.maximum).toBe(AGENT_MAX_READ_IMAGE_SIZE_BYTES);

    const allowed = await registry.execute('call-read-source', 'read', {
      files: [{ path: 'src/main.ts', extract: 'outline' }],
      image_mode: 'metadata-only',
      max_image_size: AGENT_MAX_READ_IMAGE_SIZE_BYTES,
    });
    expect(allowed.success).toBe(true);

    const tooManyFiles = Array.from({ length: AGENT_MAX_READ_FILES + 1 }, (_, index) => ({
      path: `src/example-${index}.ts`,
    }));
    const blockedInputs: ReadonlyArray<Record<string, unknown>> = [
      { files: [{ path: '.env' }] },
      { files: [{ path: 'src/.hidden/config.ts' }] },
      { files: [{ path: 'secrets/api-token.txt' }] },
      { files: [{ path: 'config/credentials.json' }] },
      { files: [{ path: 'keys/service.pem' }] },
      { files: [{ path: 'assets/diagram.png', image_mode: 'unoptimized' }] },
      { files: [{ path: 'assets/diagram.png' }], image_mode: 'unoptimized' },
      { files: [{ path: 'assets/diagram.png' }], max_image_size: AGENT_MAX_READ_IMAGE_SIZE_BYTES + 1 },
      { files: tooManyFiles },
    ];

    for (const [index, input] of blockedInputs.entries()) {
      const result = await registry.execute(`call-read-blocked-${index}`, 'read', input);
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_READ_POLICY_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows state tool to read-only runtime inspection', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeStateModeTool());

    installAgentToolPolicyGuard(registry);

    const stateDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'state');
    expect(stateDefinition?.description).toContain('Inspect runtime-owned state');
    const properties = stateDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_STATE_TOOL_MODES]);
    expect(properties.values).toBeUndefined();
    expect(properties.clearKeys).toBeUndefined();
    expect(properties.memoryValue).toBeUndefined();
    expect(properties.hookDefinition).toBeUndefined();
    expect(properties.modeName).toBeUndefined();
    expect(properties.analyticsTool).toBeUndefined();

    expect(getRecordProperty(properties, 'memoryAction')?.enum).toEqual([...AGENT_READ_ONLY_STATE_MEMORY_ACTIONS]);
    expect(getRecordProperty(properties, 'hookAction')?.enum).toEqual([...AGENT_READ_ONLY_STATE_HOOK_ACTIONS]);
    expect(getRecordProperty(properties, 'modeAction')?.enum).toEqual([...AGENT_READ_ONLY_STATE_MODE_ACTIONS]);
    expect(getRecordProperty(properties, 'analyticsAction')?.enum).toEqual([...AGENT_READ_ONLY_STATE_ANALYTICS_ACTIONS]);

    const readOnlyInputs: ReadonlyArray<Record<string, unknown>> = [
      { mode: 'get', keys: ['runtime.workingDir'] },
      { mode: 'list' },
      { mode: 'budget' },
      { mode: 'context' },
      { mode: 'memory', memoryAction: 'list' },
      { mode: 'memory', memoryAction: 'get', memoryKey: 'example' },
      { mode: 'telemetry' },
      { mode: 'hooks', hookAction: 'list' },
      { mode: 'mode', modeAction: 'get' },
      { mode: 'mode', modeAction: 'list' },
      { mode: 'analytics', analyticsAction: 'summary' },
      { mode: 'analytics', analyticsAction: 'query' },
      { mode: 'analytics', analyticsAction: 'dashboard' },
    ];

    for (const [index, input] of readOnlyInputs.entries()) {
      const result = await registry.execute(`call-state-read-${index}`, 'state', input);
      expect(result.success).toBe(true);
    }

    const blockedInputs: ReadonlyArray<Record<string, unknown>> = [
      { mode: 'set', values: { key: 'value' } },
      { mode: 'clear', clearKeys: ['key'] },
      { mode: 'get', values: { key: 'value' } },
      { mode: 'memory', memoryAction: 'set', memoryKey: 'memory', memoryValue: 'value' },
      { mode: 'memory', memoryAction: 'list', memoryValue: 'value' },
      { mode: 'hooks', hookAction: 'enable', hookName: 'hook' },
      { mode: 'hooks', hookAction: 'add', hookDefinition: { type: 'command' } },
      { mode: 'mode', modeAction: 'set', modeName: 'verbose' },
      { mode: 'analytics', analyticsAction: 'record', analyticsTool: 'fetch' },
      { mode: 'analytics', analyticsAction: 'sync' },
      { mode: 'analytics', analyticsAction: 'export', analyticsFormat: 'json' },
    ];

    for (const [index, input] of blockedInputs.entries()) {
      const result = await registry.execute(`call-state-blocked-${index}`, 'state', input);
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_STATE_MUTATION_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard keeps the settings tool usable instead of blocking it', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeSettingsTool());

    installAgentToolPolicyGuard(registry);

    const settingsDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'goodvibes_settings');
    expect(settingsDefinition?.description).toBe(AGENT_SETTINGS_TOOL_DESCRIPTION_TEXT);
    expect(settingsDefinition?.sideEffects).toEqual(['state']);
    // The old guard stripped every parameter, which left the model unable to see
    // that a settings write was something it could attempt at all.
    const properties = settingsDefinition?.parameters.properties as Record<string, unknown>;
    expect(properties.mode).toBeDefined();
    expect(properties.key).toBeDefined();
    expect(properties.value).toBeDefined();
    expect(properties.confirm).toBeDefined();
    expect(properties[AGENT_SETTINGS_CONFIRMATION_PROPERTY]).toBeDefined();

    const result = await registry.execute('call-settings-ordinary', 'goodvibes_settings', {
      mode: 'set',
      key: 'surfaces.telegram.botUsername',
      value: 'goodvibes_agent_bot',
      confirm: true,
    });
    expect(result.success).toBe(true);
  });

  test('Agent runtime guard gates a genuinely dangerous key and says which and why', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeSettingsTool());

    installAgentToolPolicyGuard(registry);

    const result = await registry.execute('call-settings-gated', 'goodvibes_settings', {
      mode: 'set',
      key: 'behavior.autoApprove',
      value: true,
      confirm: true,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('behavior.autoApprove');
    expect(result.error).toContain('auto-approves every future tool permission request');
    expect(result.error).toContain('was NOT changed');
    expect(result.error).toContain(AGENT_SETTINGS_CONFIRMATION_PROPERTY);

    const allowed = await registry.execute('call-settings-gated-confirmed', 'goodvibes_settings', {
      mode: 'set',
      key: 'behavior.autoApprove',
      value: true,
      confirm: true,
      [AGENT_SETTINGS_CONFIRMATION_PROPERTY]: 'turn on auto approve for me',
    });
    expect(allowed.success).toBe(true);
  });

  test('Agent runtime guard routes copied runtime context tool to Agent capabilities', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeContextTool());

    installAgentToolPolicyGuard(registry);
    registry.register(makeHarnessAliasTargetTool());

    const contextDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'goodvibes_context');
    expect(contextDefinition?.description).toBe('Inspect GoodVibes Agent harness capabilities.');
    expect(contextDefinition?.sideEffects).toEqual([]);
    const properties = contextDefinition?.parameters.properties as Record<string, unknown>;
    expect((properties.mode as { readonly enum?: readonly string[] }).enum).toEqual([...AGENT_CONTEXT_TOOL_COMPATIBILITY_MODES]);
    expect(properties.includeAllSpaces).toBeUndefined();
    expect(properties.knowledgeSpaceId).toBeUndefined();
    expect(contextDefinition?.parameters.additionalProperties).toBe(false);

    const result = await registry.execute('call-context-alias', 'goodvibes_context', {
      mode: 'capabilities',
      query: 'tools',
    });
    expect(result.success).toBe(true);
    const payload = JSON.parse(result.output ?? '{}') as {
      readonly runtime?: string;
      readonly currentContract?: Record<string, unknown>;
      readonly canDoNow?: readonly Record<string, unknown>[];
      readonly commonRoutes?: Record<string, unknown>;
    };
    expect(payload.runtime).toBe('GoodVibes Agent');
    expect(payload.currentContract?.autonomy).toContain('Operator agent working on the owner');
    expect(payload.canDoNow?.map((entry) => entry.area)).toContain('Harness operation');
    expect(payload.canDoNow?.map((entry) => entry.area)).toContain('Personal operations');
    expect(payload.canDoNow?.map((entry) => entry.area)).toContain('Device, voice, and browser surfaces');
    expect(payload.canDoNow?.map((entry) => entry.area)).toContain('Documents and artifacts');
    expect(payload.commonRoutes?.personalOps).toContain('personal_ops action:"briefing"');
    expect(payload.commonRoutes?.device).toContain('device action:"status"');
    expect(payload.commonRoutes?.models).toContain('models action:"status"');
    expect(payload.commonRoutes?.documentOps).toContain('agent_harness mode:"document_ops"');
    expect(payload.commonRoutes?.researchWorkflow).toContain('research action:"briefing"');
    expect(payload.commonRoutes?.webResearch).toContain('multi-step: research action:"briefing"');
    const webResearchCapability = payload.canDoNow?.find((entry) => entry.area === 'Web research') as { readonly inspect?: string } | undefined;
    expect(webResearchCapability?.inspect).toContain('research action:"briefing"');

    const legacy = await registry.execute('call-context-legacy', 'goodvibes_context', {
      mode: ['home', 'graph'].join(''),
      includeAllSpaces: true,
    });
    expect(legacy.success).toBe(true);
    expect(legacy.output).not.toContain('copied context exposed');
  });

  test('Agent runtime guard keeps inspect scaffold dry-run-only from the model surface', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeInspectTool());

    installAgentToolPolicyGuard(registry);

    const inspectDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'inspect');
    expect(inspectDefinition?.description).toContain('Inspect and analyze project structure');
    const properties = inspectDefinition?.parameters.properties as Record<string, unknown>;
    expect(properties.dryRun).toBeUndefined();

    const plan = await registry.execute('call-inspect-scaffold-plan', 'inspect', {
      mode: 'scaffold',
      moduleName: 'agent-surface',
    });
    expect(plan.success).toBe(true);
    const normalized = JSON.parse(plan.output ?? '{}') as { readonly dryRun?: boolean };
    expect(normalized.dryRun).toBe(true);

    const project = await registry.execute('call-inspect-project', 'inspect', { mode: 'project' });
    expect(project.success).toBe(true);

    const write = await registry.execute('call-inspect-scaffold-write', 'inspect', {
      mode: 'scaffold',
      moduleName: 'agent-surface',
      dryRun: false,
    });
    expect(write.success).toBe(false);
    expect(write.error).toBe(AGENT_INSPECT_WRITE_DENIAL_MESSAGE);
  });

  test('Agent runtime guard narrows copied control tool to read-only product-control inspection', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeControlTool());

    installAgentToolPolicyGuard(registry);

    const controlDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'control');
    expect(controlDefinition?.description).toContain('Read-only product-control inspection');
    expect(controlDefinition?.sideEffects).toEqual([]);
    const properties = controlDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_CONTROL_TOOL_MODES]);

    const commands = await registry.execute('call-control-commands', 'control', { mode: 'commands' });
    expect(commands.success).toBe(true);

    const mutation = await registry.execute('call-control-mutation', 'control', { mode: 'restart-daemon' });
    expect(mutation.success).toBe(false);
    expect(mutation.error).toBe(AGENT_CONTROL_MUTATION_DENIAL_MESSAGE);
  });

  test('Agent runtime guard narrows analyze to local static analysis modes', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeAnalyzeTool());

    installAgentToolPolicyGuard(registry);

    const analyzeDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'analyze');
    expect(analyzeDefinition?.description).toContain('local, static project analysis');
    expect(analyzeDefinition?.sideEffects).toEqual(['read_fs']);
    const properties = analyzeDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_ANALYZE_TOOL_MODES]);
    expect(properties.packages).toBeUndefined();

    const security = await registry.execute('call-analyze-security', 'analyze', { mode: 'security' });
    expect(security.success).toBe(true);

    for (const mode of ['upgrade', 'semantic_diff'] as const) {
      const blocked = await registry.execute(`call-analyze-${mode}`, 'analyze', { mode });
      expect(blocked.success).toBe(false);
      expect(blocked.error).toBe(AGENT_ANALYZE_NETWORK_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows registry to discovery and bounded previews', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeRegistryTool());

    installAgentToolPolicyGuard(registry);

    const registryDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'registry');
    expect(registryDefinition?.description).toContain('Discover and preview GoodVibes Agent registry entries');
    expect(registryDefinition?.sideEffects).toEqual(['read_fs']);
    const properties = registryDefinition?.parameters.properties as Record<string, unknown>;
    const modeProperty = getRecordProperty(properties, 'mode');
    expect(modeProperty?.enum).toEqual([...AGENT_READ_ONLY_REGISTRY_TOOL_MODES]);

    const search = await registry.execute('call-registry-search', 'registry', { mode: 'search', query: 'setup' });
    expect(search.success).toBe(true);

    const previewSkill = await registry.execute('call-registry-preview-skill', 'registry', {
      mode: 'preview',
      path: '.goodvibes/skills/setup/SKILL.md',
    });
    expect(previewSkill.success).toBe(true);

    const previewAgent = await registry.execute('call-registry-preview-agent', 'registry', {
      mode: 'preview',
      path: '/tmp/example/.goodvibes/agents/reviewer/AGENT.md',
    });
    expect(previewAgent.success).toBe(true);

    const content = await registry.execute('call-registry-content', 'registry', {
      mode: 'content',
      path: '.goodvibes/skills/setup/SKILL.md',
    });
    expect(content.success).toBe(false);
    expect(content.error).toBe(AGENT_REGISTRY_CONTENT_DENIAL_MESSAGE);

    const arbitraryPreview = await registry.execute('call-registry-arbitrary-preview', 'registry', {
      mode: 'preview',
      path: '.goodvibes/secrets/token.md',
    });
    expect(arbitraryPreview.success).toBe(false);
    expect(arbitraryPreview.error).toBe(AGENT_REGISTRY_CONTENT_DENIAL_MESSAGE);
  });

  test('Agent runtime guard narrows find to serial gitignore-respecting project search', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeFindTool());

    installAgentToolPolicyGuard(registry);

    const findDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'find');
    expect(findDefinition?.description).toContain('serial, gitignore-respecting');
    expect(findDefinition?.sideEffects).toEqual(['read_fs']);
    expect(findDefinition?.concurrency).toBe('serial');

    const properties = findDefinition?.parameters.properties as Record<string, unknown>;
    expect(properties.parallel).toBeUndefined();
    const queries = getRecordProperty(properties, 'queries');
    const itemSchema = queries ? getRecordProperty(queries, 'items') : undefined;
    const queryProperties = itemSchema ? getRecordProperty(itemSchema, 'properties') : undefined;
    expect(queryProperties?.follow_symlinks).toBeUndefined();
    expect(queryProperties?.include_hidden).toBeUndefined();
    expect(queryProperties?.respect_gitignore).toBeUndefined();

    const output = getRecordProperty(properties, 'output');
    const outputProperties = output ? getRecordProperty(output, 'properties') : undefined;
    const format = outputProperties ? getRecordProperty(outputProperties, 'format') : undefined;
    expect(format?.enum).toEqual([...AGENT_READ_ONLY_FIND_OUTPUT_FORMATS]);
    expect(outputProperties?.preview_lines).toBeUndefined();

    const allowed = await registry.execute('call-find-content', 'find', {
      queries: [{ id: 'source', mode: 'content', pattern: 'GoodVibes', path: 'src' }],
      output: { format: 'context', max_results: 10 },
    });
    expect(allowed.success).toBe(true);
    const normalized = JSON.parse(allowed.output ?? '{}') as { readonly parallel?: boolean };
    expect(normalized.parallel).toBe(false);

    for (const args of [
      { queries: [{ id: 'hidden', mode: 'files', patterns: ['**/*'], include_hidden: true }] },
      { queries: [{ id: 'symlink', mode: 'files', patterns: ['**/*'], follow_symlinks: true }] },
      { queries: [{ id: 'ignored', mode: 'files', patterns: ['**/*'], respect_gitignore: false }] },
      { queries: [{ id: 'preview', mode: 'files', patterns: ['**/*'] }], output: { format: 'with_preview' } },
      { queries: [{ id: 'full', mode: 'symbols', query: 'Agent' }], output: { format: 'full' } },
      { queries: [{ id: 'parallel', mode: 'content', pattern: 'Agent' }], parallel: true },
    ] satisfies ReadonlyArray<Record<string, unknown>>) {
      const blocked = await registry.execute(`call-find-blocked-${JSON.stringify(args)}`, 'find', args);
      expect(blocked.success).toBe(false);
      expect(blocked.error).toBe(AGENT_FIND_POLICY_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows web search to bounded read-only research', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeWebSearchTool());

    installAgentToolPolicyGuard(registry);

    const webSearchDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'web_search');
    expect(webSearchDefinition?.description).toContain('bounded, read-only web research');
    expect(webSearchDefinition?.sideEffects).toEqual(['network']);
    const properties = webSearchDefinition?.parameters.properties as Record<string, unknown>;
    const verbosity = getRecordProperty(properties, 'verbosity');
    const evidenceExtract = getRecordProperty(properties, 'evidenceExtract');
    const maxResults = getRecordProperty(properties, 'maxResults');
    const evidenceTopN = getRecordProperty(properties, 'evidenceTopN');
    expect(verbosity?.enum).toEqual([...AGENT_READ_ONLY_WEB_SEARCH_VERBOSITIES]);
    expect(evidenceExtract?.enum).toEqual([...AGENT_READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS]);
    expect(maxResults?.maximum).toBe(10);
    expect(evidenceTopN?.maximum).toBe(3);

    const allowed = await registry.execute('call-web-search-snippets', 'web_search', {
      query: 'goodvibes agent',
      maxResults: 5,
      verbosity: 'evidence',
      safeSearch: 'moderate',
      includeEvidence: true,
      evidenceTopN: 3,
      evidenceExtract: 'readable',
    });
    expect(allowed.success).toBe(true);

    const defaultSafeSearch = await registry.execute('call-web-search-default-safe', 'web_search', {
      query: 'goodvibes agent',
    });
    expect(defaultSafeSearch.success).toBe(true);
    expect(defaultSafeSearch.output).toContain('"safeSearch":"moderate"');

    for (const args of [
      { query: 'x', verbosity: 'full' },
      { query: 'x', safeSearch: 'off' },
      { query: 'x', maxResults: 25 },
      { query: 'x', includeEvidence: true, evidenceTopN: 10 },
      { query: 'x', includeEvidence: true, evidenceExtract: 'raw' },
      { query: 'x', includeEvidence: true, evidenceExtract: 'summary' },
    ]) {
      const blocked = await registry.execute(`call-web-search-blocked-${JSON.stringify(args)}`, 'web_search', args);
      expect(blocked.success).toBe(false);
      expect(blocked.error).toBe(AGENT_WEB_SEARCH_POLICY_DENIAL_MESSAGE);
    }
  });

  test('Agent runtime guard narrows copied durable workflow tools to read-only inspection', async () => {
    const registry = new ToolRegistry();
    const guarded = makeAgentHarness();
    registry.register(guarded.agentTool);
    registry.register(makeDurableModeTool('task', ['create', 'list', 'show', 'status', 'depend', 'cancel', 'handoff', 'handoffs'], [
      'title',
      'label',
      'status',
      'dependsOnSessionId',
      'dependsOnTaskId',
      'reason',
      'toSessionId',
    ]));
    registry.register(makeDurableModeTool('team', ['create', 'list', 'show', 'add-member', 'remove-member', 'set-lanes', 'delete'], [
      'name',
      'summary',
      'memberId',
      'role',
      'lanes',
    ]));
    registry.register(makeDurableModeTool('worklist', ['create', 'list', 'show', 'add-item', 'complete-item', 'reopen-item', 'remove-item'], [
      'title',
      'itemId',
      'text',
      'owner',
      'priority',
    ]));
    registry.register(makeDurableModeTool('packet', ['create', 'list', 'show', 'revise', 'publish'], [
      'title',
      'summary',
      'goals',
      'constraints',
      'risks',
      'audience',
    ]));
    registry.register(makeDurableModeTool('query', ['ask', 'list', 'show', 'answer', 'close'], [
      'prompt',
      'askedBy',
      'target',
      'answer',
      'resolution',
    ]));

    installAgentToolPolicyGuard(registry);

    const expectations = [
      {
        name: 'task',
        allowedModes: AGENT_READ_ONLY_TASK_TOOL_MODES,
        blockedModes: ['create', 'status', 'depend', 'cancel', 'handoff'] as const,
        removed: ['title', 'label', 'status', 'dependsOnSessionId', 'dependsOnTaskId', 'reason', 'toSessionId'] as const,
      },
      {
        name: 'team',
        allowedModes: AGENT_READ_ONLY_TEAM_TOOL_MODES,
        blockedModes: ['create', 'add-member', 'remove-member', 'set-lanes', 'delete'] as const,
        removed: ['name', 'summary', 'memberId', 'role', 'lanes'] as const,
      },
      {
        name: 'worklist',
        allowedModes: AGENT_READ_ONLY_WORKLIST_TOOL_MODES,
        blockedModes: ['create', 'add-item', 'complete-item', 'reopen-item', 'remove-item'] as const,
        removed: ['title', 'itemId', 'text', 'owner', 'priority'] as const,
      },
      {
        name: 'packet',
        allowedModes: AGENT_READ_ONLY_PACKET_TOOL_MODES,
        blockedModes: ['create', 'revise', 'publish'] as const,
        removed: ['title', 'summary', 'goals', 'constraints', 'risks', 'audience'] as const,
      },
      {
        name: 'query',
        allowedModes: AGENT_READ_ONLY_QUERY_TOOL_MODES,
        blockedModes: ['ask', 'answer', 'close'] as const,
        removed: ['prompt', 'askedBy', 'target', 'answer', 'resolution'] as const,
      },
    ] as const;

    for (const expectation of expectations) {
      const definition = registry.getToolDefinitions().find((tool) => tool.name === expectation.name);
      expect(definition?.description).toContain('Read-only');
      expect(definition?.description).toContain('Mutations are disabled in Agent.');
      const properties = definition?.parameters.properties as Record<string, unknown>;
      const modeProperty = getRecordProperty(properties, 'mode');
      expect(modeProperty?.enum).toEqual([...expectation.allowedModes]);
      for (const key of expectation.removed) expect(properties[key]).toBeUndefined();

      for (const mode of expectation.allowedModes) {
        const result = await registry.execute(`call-${expectation.name}-${mode}`, expectation.name, { mode });
        expect(result.success).toBe(true);
      }

      for (const mode of expectation.blockedModes) {
        const result = await registry.execute(`call-${expectation.name}-blocked-${mode}`, expectation.name, { mode });
        expect(result.success).toBe(false);
        expect(result.error).toBe(AGENT_DURABLE_WORKFLOW_MUTATION_DENIAL_MESSAGE);
      }
    }
  });
});

