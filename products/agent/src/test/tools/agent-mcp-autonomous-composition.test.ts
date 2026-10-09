import { expect, test } from 'bun:test';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { gateReadingsPort } from '../../../../../packages/engine/test/_helpers/gate-readings.ts';
import { PermissionManager, type PermissionConfigReader } from '../../../../../packages/engine/sdk/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../../../../../packages/engine/sdk/src/platform/runtime/permissions/policy-runtime.ts';
import { McpRegistry } from '../../../../../packages/engine/sdk/src/platform/mcp/registry.ts';
import { McpClient } from '../../../../../packages/engine/sdk/src/platform/mcp/client.ts';
import { createRuntimeMcpApi } from '../../../../../packages/engine/sdk/src/platform/runtime/runtime-mcp-api.ts';
import { withExternalOperationSource } from '../../../../../packages/engine/sdk/src/platform/permissions/external-operation-scope.ts';
import { createToolRegistryDouble } from '../helpers/tool-registry-double.ts';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { CommandContext } from '../../input/command-registry.ts';
import { installAgentMcpCallRoute, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';

for (const outcome of ['act', 'reject', 'abort']) test(`real Agent route and facade reach canonical HTTP ${outcome}`, async () => {
  using log = new SqliteDecisionLog(':memory:');
  const gate = gateReadingsPort([['', { outward: true, capability: 'network_write' }]]);
  const semantic = fakePort((_name, question) => choiceAnswer(question, outcome === 'reject' ? 'reject' : 'act', 0.99));
  const port: JudgmentPort = withDecisionLog({ model: gate.port.model, ask(request) {
    request.beforeAttempt?.(); return 'disposition' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, log);
  const prior = installJudgmentPort(port); const controller = new AbortController();
  let humans = 0; let writes = 0;
  const config = { isAutoApproveEnabled: () => false, getWorkingDirectory: () => '/synthetic/project',
    getSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} } }),
    getAutonomousSnapshot: () => ({ permissions: { mode: 'prompt', tools: {} }, autoApprove: false, directory: '/synthetic/project' }),
  } as PermissionConfigReader;
  const manager = new PermissionManager(async () => { humans++; throw new Error('No human'); }, config, new PolicyRuntimeState());
  const fetchImpl = (async (_url: unknown, init: RequestInit) => {
    if (init.method === 'DELETE') return new Response(null, { status: 202 });
    const message = JSON.parse(String(init.body)) as { id: unknown; method: string };
    if (message.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
    if (message.method === 'server/discover') return json({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'legacy' } });
    let result: unknown;
    if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: {} };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'write', description: 'synthetic', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') { writes++; result = { content: [{ type: 'text', text: 'done' }] }; }
    else throw new Error('Unexpected synthetic HTTP method');
    return json({ jsonrpc: '2.0', id: message.id, result });
  }) as typeof fetch;
  const client = new McpClient({ name: 'synthetic', url: 'https://synthetic.invalid/mcp' }, { fetchImpl });
  try {
    await client.connect();
    const registry = new McpRegistry({ hookDispatcher: { fire: async event => {
      if (event.phase === 'Pre' && outcome === 'abort') controller.abort(); return { ok: true };
    } }, sandboxSessions: {} as never });
    registry.setPermissionHost({ port, permissionManager: manager, config: { onDidInvalidate: () => () => {} }, signal: new AbortController().signal });
    const internal = registry as unknown as { clients: Map<string, McpClient>; permissions: { registerServer(name: string): void } };
    internal.clients.set('synthetic', client); internal.permissions.registerServer('synthetic');
    const api = createRuntimeMcpApi(registry);
    const tools = createToolRegistryDouble();
    const tool: Tool = { definition: { name: 'mcp', description: 'MCP', parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['servers'] } } } }, execute: async () => ({ success: true }) };
    tools.register(tool); resetAgentMcpCallRouteForTests();
    expect(installAgentMcpCallRoute(tools, { clients: { mcpApi: api } } as unknown as CommandContext)).toBe(true);
    const result = await withExternalOperationSource({ sourceOf: () => ({ goal: 'Perform the requested synthetic write', criteria: [] }), assertCurrent() {} },
      () => tool.execute({ mode: 'call', qualifiedName: 'mcp:synthetic:write', input: { text: 'requested' } }, { signal: controller.signal }));
    expect(result.success).toBe(outcome === 'act'); expect(writes).toBe(outcome === 'act' ? 1 : 0); expect(humans).toBe(0);
  } finally { await client.disconnect(); installJudgmentPort(prior); resetAgentMcpCallRouteForTests(); }
});
