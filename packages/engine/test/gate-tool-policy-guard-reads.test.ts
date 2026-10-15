// Ported from the tool policy guard tests in goodvibes-agent
// src/test/tools/agent.test.ts (the guard hoisted to gate/policy/). The agent
// test drove the guard through a real agent tool built on the agent manager;
// here a fake agent tool with the same mode enum stands in, since what is under
// test is the guard's allowlist, not the agent manager. The goodvibes_context
// wrapper stays with the product and is passed in, and the agent tool's modes
// are allowlisted by name.
// Part two: read, inspect, control, analyze, registry, find, web search,
// the durable workflow tools, and the product-supplied pieces.
import { useGateReadings } from './_helpers/gate-readings.ts';
import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { Tool } from '../sdk/src/platform/types/tools.ts';
import {
  AGENT_ANALYZE_NETWORK_DENIAL_MESSAGE,
  AGENT_CONTROL_MUTATION_DENIAL_MESSAGE,
  AGENT_DURABLE_WORKFLOW_MUTATION_DENIAL_MESSAGE,
  AGENT_FIND_POLICY_DENIAL_MESSAGE,
  AGENT_INSPECT_WRITE_DENIAL_MESSAGE,
  AGENT_MAX_READ_FILES,
  AGENT_MAX_READ_IMAGE_SIZE_BYTES,
  AGENT_READ_IMAGE_MODES,
  AGENT_READ_ONLY_ANALYZE_TOOL_MODES,
  AGENT_READ_ONLY_CONTROL_TOOL_MODES,
  AGENT_READ_ONLY_FIND_OUTPUT_FORMATS,
  AGENT_READ_ONLY_MCP_TOOL_MODES,
  AGENT_READ_ONLY_PACKET_TOOL_MODES,
  AGENT_READ_ONLY_QUERY_TOOL_MODES,
  AGENT_READ_ONLY_REGISTRY_TOOL_MODES,
  AGENT_READ_ONLY_TASK_TOOL_MODES,
  AGENT_READ_ONLY_TEAM_TOOL_MODES,
  AGENT_READ_ONLY_WEB_SEARCH_EVIDENCE_EXTRACTS,
  AGENT_READ_ONLY_WEB_SEARCH_VERBOSITIES,
  AGENT_READ_ONLY_WORKLIST_TOOL_MODES,
  AGENT_READ_POLICY_DENIAL_MESSAGE,
  AGENT_REGISTRY_CONTENT_DENIAL_MESSAGE,
  AGENT_WEB_SEARCH_POLICY_DENIAL_MESSAGE,
  explainAgentToolPolicyInvocation,
  installAgentToolPolicyGuard,
  isBlockedReadPath,
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

// Which reads touch secret or credential material is a Jev reading
// (engine.gate.side-effect `secrets`); these paths read as yes, every other
// path as no. A hidden directory alone is not a secret.
useGateReadings([
  ['.ssh/', { mutates: false, secrets: true }],
  ['id_rsa', { mutates: false, secrets: true }],
  ['.env', { mutates: false, secrets: true }],
  ['api-token.txt', { mutates: false, secrets: true }],
  ['credentials.json', { mutates: false, secrets: true }],
  ['service.pem', { mutates: false, secrets: true }],
]);

describe('the Agent main-conversation tool guard: read and inspection tools', () => {
  test('Agent preserves shared read options and schema', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    const tool = makeReadTool();
    const definition = structuredClone(tool.definition);
    registry.register(tool);
    installAgentToolPolicyGuard(registry);
    expect(tool.definition).toEqual(definition);
    const args = { files: Array.from({ length: 51 }, (_, i) => ({ path: `src/${i}.ts` })), image_mode: 'unoptimized', max_image_size: 10_000_000 };
    const result = await registry.execute('supported-options', 'read', args);
    expect(result.success, result.error).toBe(true);
  });


  test('Agent runtime guard keeps inspect scaffold dry-run-only from the model surface', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
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
    registry.register(makeFakeAgentTool().tool);
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

  test('Agent preserves shared analyze options and schema', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    const tool = makeAnalyzeTool();
    const definition = structuredClone(tool.definition);
    registry.register(tool);
    installAgentToolPolicyGuard(registry);
    expect(tool.definition).toEqual(definition);
    const args = { mode: 'upgrade', packages: ['fixture'] };
    const result = await registry.execute('supported-options', 'analyze', args);
    expect(result.success, result.error).toBe(true);
  });


  test('Agent runtime guard narrows registry to discovery and bounded previews', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    registry.register(makeRegistryTool());

    installAgentToolPolicyGuard(registry);

    const registryDefinition = registry.getToolDefinitions().find((tool) => tool.name === 'registry');
    expect(registryDefinition?.description).toBe(makeRegistryTool().definition.description);
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
    expect(content.success).toBe(true);

    const arbitraryPreview = await registry.execute('call-registry-arbitrary-preview', 'registry', {
      mode: 'preview',
      path: '.goodvibes/secrets/token.md',
    });
    expect(arbitraryPreview.success).toBe(false);
    expect(arbitraryPreview.error).toBe(AGENT_REGISTRY_CONTENT_DENIAL_MESSAGE);
  });

  test('Agent preserves shared find options and schema', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    const tool = makeFindTool();
    const definition = structuredClone(tool.definition);
    registry.register(tool);
    installAgentToolPolicyGuard(registry);
    expect(tool.definition).toEqual(definition);
    const args = { queries: [{ id: 'all', mode: 'files', patterns: ['**/*'], include_hidden: true, follow_symlinks: true, respect_gitignore: false }], parallel: true, output: { format: 'full', preview_lines: 30 } };
    const result = await registry.execute('supported-options', 'find', args);
    expect(result.success, result.error).toBe(true);
  });


  test('Agent preserves shared web_search options and schema', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    const tool = makeWebSearchTool();
    const definition = structuredClone(tool.definition);
    registry.register(tool);
    installAgentToolPolicyGuard(registry);
    expect(tool.definition).toEqual(definition);
    const args = { query: 'fixture', maxResults: 25, evidenceTopN: 10, verbosity: 'full', evidenceExtract: 'raw', safeSearch: 'off' };
    const result = await registry.execute('supported-options', 'web_search', args);
    expect(result.success, result.error).toBe(true);
  });


  test('Agent runtime guard narrows copied durable workflow tools to read-only inspection', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
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

  test('the product\'s goodvibes_context wrapper is applied through the options', () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    registry.register(makeNoopTool('goodvibes_context'));
    const wrapped: string[] = [];
    installAgentToolPolicyGuard(registry, {
      wrapContextTool: (tool, owner) => {
        expect(owner).toBe(registry);
        wrapped.push(tool.definition.name);
      },
    });
    expect(wrapped).toEqual(['goodvibes_context']);
  });

  test('local reads use configured access checks rather than Jev path labels', async () => {
    const registry = new ToolRegistry();
    registry.register(makeFakeAgentTool().tool);
    registry.register(makeReadTool());
    installAgentToolPolicyGuard(registry, {});
    expect((await registry.execute('call-read-hidden', 'read', { files: [{ path: '/home/u/.goodvibes-screen.png' }] })).success).toBe(true);
    expect((await registry.execute('call-read-secret', 'read', { files: [{ path: '/home/u/.ssh/config' }] })).success).toBe(true);
    expect(await isBlockedReadPath('/home/u/.ssh/config')).toBe(false);
    expect(await isBlockedReadPath('/home/u/project/README.md')).toBe(false);
  });

  test('the mcp explanation lists the call mode only when the product says its route is installed', async () => {
    expect((await explainAgentToolPolicyInvocation('mcp', { mode: 'call' })).status).toBe('denied');
    const withRoute = await explainAgentToolPolicyInvocation('mcp', { mode: 'call' }, { mcpCallMode: 'call' });
    expect(withRoute.status).toBe('allowed');
    expect(withRoute.allowedModes).toEqual([...AGENT_READ_ONLY_MCP_TOOL_MODES, 'call']);
  });
});
