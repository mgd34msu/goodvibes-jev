import { describe, test, expect } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { registerAllTools } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createTestManagers } from '../helpers/test-managers.ts';
import { CrossSessionTaskRegistry } from '@goodvibes-jev/engine/sdk/platform/sessions';
import { SandboxSessionRegistry } from '@/runtime/index.ts';
import { RemoteRunnerRegistry } from '@/runtime/index.ts';
import { AgentMessageBus } from '@goodvibes-jev/engine/sdk/platform/agents';
import { AgentManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { OverflowHandler } from '@goodvibes-jev/engine/sdk/platform/tools';
import { FileUndoManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { ModeManager } from '@goodvibes-jev/engine/sdk/platform/state';
import { ProcessManager } from '@goodvibes-jev/engine/sdk/platform/tools';
import { createWorkflowServices } from '@goodvibes-jev/engine/sdk/platform/tools';
import { compactRegisteredToolDefinitions } from '../../tools/tool-definition-compaction.ts';
import { installAgentToolPolicyGuard } from '../../tools/agent-tool-policy-guard.ts';
import { installToolExecutionSafetyGuard } from '../../tools/tool-execution-safety.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function registerTools(registry: ToolRegistry): string {
  const services = createTestManagers();
  const workingDirectory = makeProjectTempDir('gv-tool-registry');
  const agentManager = new AgentManager({
    messageBus: new AgentMessageBus(),
    configManager: services.configManager,
  });
  const sessionOrchestration = new CrossSessionTaskRegistry(
    join(workingDirectory, '.goodvibes', 'tui', 'sessions', 'task-graph.json'),
  );
  const sandboxSessionRegistry = new SandboxSessionRegistry(workingDirectory);
  const remoteRunnerRegistry = new RemoteRunnerRegistry(agentManager);
  const agentMessageBus = new AgentMessageBus();
  registerAllTools(registry, {
    surfaceRoot: 'tui',
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentManager,
    agentMessageBus,
    configManager: services.configManager,
    providerRegistry: services.providerRegistry,
    toolLLM: services.toolLLM,
    sessionOrchestration,
    sandboxSessionRegistry,
    workingDirectory,
    overflowHandler: new OverflowHandler({ baseDir: workingDirectory }),
    webSearchService: {
      search: async () => [],
    } as never,
    channelRegistry: null,
    remoteRunnerRegistry,
    workflowServices: createWorkflowServices(),
    mcpRegistry: {
      list: () => [],
    } as never,
  });
  return workingDirectory;
}

describe('registerAllTools', () => {

  test('compacted model-visible tool descriptions stay within the prompt budget', () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    compactRegisteredToolDefinitions(registry);
    for (const tool of registry.list()) {
      expect(tool.definition.description.length).toBeLessThanOrEqual(56);
      expect(tool.definition.description).not.toContain('...');
    }
  });

  test('Agent-guarded platform tools all return structured results instead of throwing', async () => {
    const registry = new ToolRegistry();
    registerTools(registry);
    installAgentToolPolicyGuard(registry);
    installToolExecutionSafetyGuard(registry);

    const smokeArgs: Record<string, Record<string, unknown>> = {
      agent: { mode: 'list' },
      analyze: { mode: 'impact', target: 'package.json' },
      channel: { mode: 'accounts' },
      control: { mode: 'commands' },
      edit: {},
      exec: { commands: [] },
      fetch: { urls: [] },
      find: { mode: 'files', query: 'package.json' },
      goodvibes_context: { mode: 'summary' },
      goodvibes_settings: { mode: 'set', key: 'provider.model', confirm: false },
      inspect: { mode: 'project' },
      mcp: { mode: 'servers' },
      packet: { mode: 'list' },
      query: { mode: 'list' },
      read: {},
      registry: { mode: 'list' },
      remote: { mode: 'pools' },
      repl: {},
      state: { mode: 'get' },
      task: { mode: 'list' },
      team: { mode: 'list' },
      web_search: { query: 'goodvibes', topN: 1 },
      workflow: { mode: 'list' },
      worklist: { mode: 'list' },
      write: {},
    };

    for (const tool of registry.list()) {
      const callId = `smoke-${tool.definition.name}`;
      const result = await registry.execute(callId, tool.definition.name, smokeArgs[tool.definition.name] ?? {});
      expect(result.callId, tool.definition.name).toBe(callId);
      expect(typeof result.success, tool.definition.name).toBe('boolean');
      expect(result.success || typeof result.error === 'string' || typeof result.output === 'string', tool.definition.name).toBe(true);
    }
  });

  test('post-edit diagnostics (SDK 1.6.1 diagnostics.postEdit) reach the write tool result untouched', async () => {
    const registry = new ToolRegistry();
    const workingDirectory = registerTools(registry);
    // Install the SAME guard layers production bootstrap installs
    // (installAgentToolPolicyGuard, installToolExecutionSafetyGuard),
    // neither wraps the write tool's execute function, but this proves that
    // rather than assumes it: diagnostics must still reach the result.
    installAgentToolPolicyGuard(registry);
    installToolExecutionSafetyGuard(registry);
    // hasTsProjectContext() walks up from the written file looking for
    // tsconfig.json/jsconfig.json, without one, the provider honestly
    // returns [] rather than fabricating "no errors".
    writeFileSync(join(workingDirectory, 'tsconfig.json'), '{}\n');

    const result = await registry.execute('write-diagnostics-smoke', 'write', {
      files: [{
        path: 'broken.ts',
        // Deliberately unbalanced, a real syntax error, not a type error.
        content: 'export function broken( {\n  return 1\n',
      }],
    });

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe('string');
    const parsed = JSON.parse(result.output ?? '{}') as { diagnostics?: readonly { file: string; message: string }[] };
    expect(Array.isArray(parsed.diagnostics)).toBe(true);
    expect(parsed.diagnostics!.length).toBeGreaterThan(0);
    expect(parsed.diagnostics![0]!.file).toContain('broken.ts');
  });
});
