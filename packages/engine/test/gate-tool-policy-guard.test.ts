// Ported from the tool policy guard tests in goodvibes-agent
// src/test/tools/agent.test.ts (the guard hoisted to gate/policy/). The agent
// test drove the guard through a real agent tool built on the agent manager;
// here a fake agent tool with the same mode enum stands in, since what is under
// test is the guard's allowlist, not the agent manager. The goodvibes_context
// wrapper stays with the product and is passed in, and the agent tool's modes
// are allowlisted by name.
// Part one: the agent tool, exec, remote, channel, MCP, fetch, state and
// settings.
import { describe, expect, test } from 'bun:test';
import { useGateReadings } from './_helpers/gate-readings.ts';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import {
  AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES,
  AGENT_CHANNEL_ACTION_DENIAL_MESSAGE,
  AGENT_EXEC_BACKGROUND_DENIAL_MESSAGE,
  AGENT_FETCH_NETWORK_MUTATION_DENIAL_MESSAGE,
  AGENT_LOCAL_SPAWN_DENIAL_MESSAGE,
  AGENT_MAIN_CONVERSATION_TOOL_DENIAL_MESSAGE,
  AGENT_MCP_SECURITY_MUTATION_DENIAL_MESSAGE,
  AGENT_READ_ONLY_CHANNEL_TOOL_MODES,
  AGENT_READ_ONLY_FETCH_METHODS,
  AGENT_READ_ONLY_MCP_TOOL_MODES,
  AGENT_READ_ONLY_REMOTE_TOOL_MODES,
  AGENT_READ_ONLY_STATE_ANALYTICS_ACTIONS,
  AGENT_READ_ONLY_STATE_HOOK_ACTIONS,
  AGENT_READ_ONLY_STATE_MEMORY_ACTIONS,
  AGENT_READ_ONLY_STATE_MODE_ACTIONS,
  AGENT_READ_ONLY_STATE_TOOL_MODES,
  AGENT_READ_ONLY_TOOL_MODES,
  AGENT_REMOTE_MUTATION_DENIAL_MESSAGE,
  AGENT_SETTINGS_CONFIRMATION_PROPERTY,
  AGENT_SETTINGS_TOOL_DESCRIPTION_TEXT,
  AGENT_STATE_MUTATION_DENIAL_MESSAGE,
  installAgentToolPolicyGuard,
  normalizeAgentToolInvocationForAgentPolicy,
  wrapAgentToolForAgentPolicy,
  wrapBlockedMainConversationToolForAgentPolicy,
} from '../sdk/src/platform/gate/policy/index.ts';

/** The agent tool's own mode enum, as the engine's agent tool declares it. */
const AGENT_TOOL_MODES = ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'contracts', 'contract-history', 'cohort-status', 'cohort-report'] as const;

function makeFakeAgentTool(): { readonly tool: Tool; readonly calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const tool: Tool = {
    definition: {
      name: 'agent',
      description: 'agent test tool',
      parameters: { type: 'object', properties: { mode: { type: 'string', enum: [...AGENT_TOOL_MODES] }, task: { type: 'string' } } },
      sideEffects: ['agent'],
    },
    execute: async (args) => {
      calls.push(args as Record<string, unknown>);
      return { success: true, output: JSON.stringify(args) };
    },
  };
  return { tool, calls };
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

describe('the agent tool under the guard', () => {
  test('visible tracked agent modes reach the agent tool unchanged', async () => {
    const { tool, calls } = makeFakeAgentTool();
    wrapAgentToolForAgentPolicy(tool);
    for (const mode of ['spawn', 'batch-spawn', 'cancel', 'wait', 'message', 'cohort-report'] as const) {
      const result = await tool.execute({ mode, task: 'Build the feature' });
      expect(result.success).toBe(true);
    }
    expect(calls.map((call) => call.mode)).toEqual(['spawn', 'batch-spawn', 'cancel', 'wait', 'message', 'cohort-report']);
  });

  test('a mode outside the allowlist, including an agent tool mode it does not name, is refused before the tool runs', async () => {
    const { tool, calls } = makeFakeAgentTool();
    wrapAgentToolForAgentPolicy(tool);
    const allowed = new Set<string>(AGENT_READ_ONLY_TOOL_MODES);
    const unlisted = AGENT_TOOL_MODES.filter((mode) => !allowed.has(mode));
    for (const mode of [...unlisted, 'delete-everything']) {
      const result = await tool.execute({ mode });
      expect(result.success).toBe(false);
      expect(result.error).toBe(AGENT_LOCAL_SPAWN_DENIAL_MESSAGE);
    }
    expect(calls).toEqual([]);
  });

  test('the guarded agent tool advertises only the visible autonomy modes', () => {
    const { tool } = makeFakeAgentTool();
    wrapAgentToolForAgentPolicy(tool);
    expect(tool.definition.description).toContain('Visible local Agent orchestration');
    const properties = expectPresent(tool.definition.parameters.properties as Record<string, unknown> | undefined, 'guarded agent schema properties');
    const modeProperty = expectPresent(getRecordProperty(properties, 'mode'), 'guarded agent mode property');
    expect(modeProperty.enum).toEqual([...AGENT_READ_ONLY_TOOL_MODES]);
    expect(modeProperty.enum).toContain('spawn');
    expect(modeProperty.enum).toContain('batch-spawn');
    // The contract read modes (the renamed chain and history modes of the old guard) are allowed.
    expect(modeProperty.enum).toContain('contracts');
    expect(modeProperty.enum).toContain('contract-history');
    expect(AGENT_READ_ONLY_TOOL_MODES.every((mode) => (AGENT_TOOL_MODES as readonly string[]).includes(mode))).toBe(true);
  });

  test('read-only agent inspection modes are left unchanged', () => {
    expect(normalizeAgentToolInvocationForAgentPolicy({ mode: 'list', status: 'running' })).toEqual({ mode: 'list', status: 'running' });
  });

  test('installing the guard without an agent tool fails loudly', () => {
    expect(() => installAgentToolPolicyGuard(new ToolRegistry())).toThrow('could not find the agent tool');
  });
});

describe('the Agent main-conversation tool guard', () => {
  // Which settings writes wait for the owner is a Jev reading
  // (engine.gate.settings-hazard); the first matching entry answers.
  useGateReadings([
    ['turn on auto approve for me', { hazard: 'approval-gate', requested: true }],
    ['behavior.autoApprove', { hazard: 'approval-gate', requested: false }],
  ]);

  test('a blocked main-conversation tool is emptied and refuses every call, naming the rule', async () => {
    // The blocked-name list is empty today; the wrapper it applies is what a
    // name added to it gets, so the wrapper is exercised directly.
    expect(AGENT_BLOCKED_MAIN_CONVERSATION_TOOL_NAMES).toEqual([]);
    const registry = new ToolRegistry();
    const tool = makeNoopTool('write');
    wrapBlockedMainConversationToolForAgentPolicy(tool);
    registry.register(tool);

    const definition = registry.getToolDefinitions().find((entry) => entry.name === 'write');
    expect(definition?.description).toBe('Blocked in GoodVibes Agent: write.');
    expect(definition?.sideEffects).toEqual([]);

    const result = await registry.execute('call-write', 'write', {});
    expect(result.success).toBe(false);
    expect(result.error).toBe(AGENT_MAIN_CONVERSATION_TOOL_DENIAL_MESSAGE);
    expect(result.callId).toBe('call-write');
  });

  test('Agent runtime guard narrows exec to foreground serial commands', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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

  test('Agent runtime guard narrows state tool to read-only runtime inspection', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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
    expect(result.error).toContain('the Agent would be granting itself permission');
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
});
