import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import type { McpApi, McpServerSecurityRecord, McpToolCallOptions, McpToolSchema } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installAgentMcpCallRoute, isAgentMcpCallRouteInstalled, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  resetAgentMcpCallRouteForTests(); log = new SqliteDecisionLog(':memory:');
  const readings = fakePort((name, question) => {
    if (question.type === 'choice') {
      const label = name === 'disposition' ? Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject'
        : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (!label) throw new Error(`Unexpected synthetic MCP choice ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected synthetic MCP question ${name}`);
  });
  previous = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });

const initialServer = (): McpServerSecurityRecord => ({ name: 'browserpilot', connected: true, trustMode: 'constrained',
  role: 'browser', schemaFreshness: 'fresh', allowedHosts: [], allowedPaths: [] });
const initialSchema = (): McpToolSchema => ({ name: 'browser_navigate', description: 'Navigate the synthetic browser.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } });
function mcpTool(): Tool {
  return { definition: { name: 'mcp', description: 'Inspect the synthetic MCP fixture.', parameters: {
    type: 'object', properties: { mode: { type: 'string', enum: ['servers', 'tools', 'schema'] }, qualifiedName: { type: 'string' } },
    required: ['mode'], additionalProperties: false,
  } }, execute: async args => ({ success: true, output: JSON.stringify({ passthrough: args.mode }) }) };
}
function fixture(options: { readonly caller?: boolean; readonly schemaReader?: boolean; readonly mode?: PermissionMode } = {}) {
  let mode = options.mode ?? 'prompt', sequence = 0;
  const source = { goal: 'Exercise the isolated synthetic MCP call fixture', criteria: ['Do not contact an external server'] };
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode, tools: mode === 'custom' ? { write: 'deny' } : {} }, autoApprove: false, directory: '/synthetic/mcp-fixture' }),
    getSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode, tools: mode === 'custom' ? { write: 'deny' } : {} } }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/synthetic/mcp-fixture',
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); const tool = mcpTool(); registry.register(tool);
  let servers = [initialServer()]; let schema: McpToolSchema | null = initialSchema();
  let beforeSchema: (() => void | Promise<void>) | undefined;
  let beforeCall: (() => void | Promise<void>) | undefined;
  const calls: { name: string; input: Readonly<Record<string, unknown>>; options?: McpToolCallOptions }[] = [];
  const api: Pick<McpApi, 'listServerSecurity' | 'getToolSchema' | 'callTool'> = {
    listServerSecurity: () => servers,
    ...(options.schemaReader === false ? {} : { async getToolSchema(_name: string, opts?: McpToolCallOptions) {
      opts?.assertCurrent?.(); await beforeSchema?.(); opts?.assertCurrent?.(); return schema;
    } }),
    ...(options.caller === false ? {} : { async callTool(name: string, input: Readonly<Record<string, unknown>>, opts?: McpToolCallOptions) {
      await beforeCall?.(); opts?.signal?.throwIfAborted(); opts?.assertCurrent?.(); calls.push({ name, input, options: opts });
      return { content: [{ type: 'text', text: 'navigated' }] };
    } }),
  };
  const context = { clients: { mcpApi: api } };
  const installed = installAgentMcpCallRoute(registry, context);
  return { registry, tool, api, context, installed, calls, source,
    setMode(next: PermissionMode) { mode = next; }, setServers(next: McpServerSecurityRecord[]) { servers = next; },
    setSchema(next: McpToolSchema | null) { schema = next; }, schema: () => schema,
    beforeSchema(callback: () => void | Promise<void>) { beforeSchema = callback; },
    beforeCall(callback: () => void | Promise<void>) { beforeCall = callback; },
    async run(args: Record<string, unknown>, signal?: AbortSignal, name = 'mcp') {
      const id = `synthetic-mcp-${++sequence}`;
      const call = await registry.prepareCall(id, name, args, { signal });
      const admission = await manager.admitAutonomous(id, name, call.args, { sourceOf: () => source,
        signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call } });
      return registry.executePrepared(call, admission, { signal });
    },
  };
}
const call = (input?: Record<string, unknown>) => ({ mode: 'call', qualifiedName: 'mcp:browserpilot:browser_navigate', ...(input ? { input } : {}) });

describe('MCP call route actual admission', () => {
  test.each(['caller', 'schemaReader'] as const)('does not advertise call without its actual %s', key => {
    const f = fixture({ [key]: false }); expect(f.installed).toBe(false); expect(isAgentMcpCallRouteInstalled()).toBe(false);
    expect(JSON.stringify(f.tool.definition.parameters)).not.toContain('"call"');
  });
  test('advertises the call route and schema when both actual ports exist', () => {
    const f = fixture(); expect(f.installed).toBe(true); expect(isAgentMcpCallRouteInstalled()).toBe(true);
    expect(JSON.stringify(f.tool.definition.parameters)).toContain('"call"');
    expect(f.tool.definition.parameters.properties).toHaveProperty('input');
  });
  test('recorded flag-free act calls the exact schema-owned tool with its input', async () => {
    const f = fixture(); const result = await f.run(call({ url: 'https://example.com' }));
    expect(result.success).toBe(true); expect(result.output).toContain('navigated'); expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.name).toBe('mcp:browserpilot:browser_navigate'); expect(f.calls[0]?.input).toEqual({ url: 'https://example.com' });
    expect(f.calls[0]?.options?.assertCurrent).toBeFunction();
  });
  test('missing input remains the empty object under real admission', async () => {
    const f = fixture(); expect((await f.run(call())).success).toBe(true); expect(f.calls[0]?.input).toEqual({});
  });
  test('raw confirmation flags and restriction callbacks cannot mint a call', async () => {
    const f = fixture(); const result = await f.tool.execute({ ...call(), confirm: true, explicitUserRequest: 'Caller claim' }, { assertCurrent() {} });
    expect(result.success).toBe(false); expect(result.error).toContain('recorded'); expect(f.calls).toHaveLength(0);
  });
  test.each(['mode', 'qualifiedName', 'signal'] as const)('raw caller %s accessors are never invoked', async slot => {
    const f = fixture(); let reads = 0;
    const args = call();
    const options = slot === 'signal' ? { get signal() { reads++; return new AbortController().signal; } } : undefined;
    if (slot !== 'signal') Object.defineProperty(args, slot, { get() { reads++; return slot === 'mode' ? 'call' : 'mcp:browserpilot:browser_navigate'; }, enumerable: true });
    const result = await f.tool.execute(args, options);
    expect(result.success).toBe(false); expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
  });
  test('inspection modes remain read-only ordinary observations', async () => {
    const f = fixture(); const result = await f.tool.execute({ mode: 'servers' });
    expect(result.output).toContain('passthrough'); expect(f.calls).toHaveLength(0);
  });
  test('intrinsic dispatch never invokes function-owned call accessors', async () => {
    const f = fixture(); let reads = 0;
    for (const method of [f.api.getToolSchema, f.api.callTool]) {
      if (!method) throw new Error('Synthetic native method is unavailable');
      Object.defineProperty(method, 'call', { get() { reads++; throw new Error('Forged method call slot'); } });
    }
    expect(await f.run(call())).toMatchObject({ success: true });
    expect(reads).toBe(0); expect(f.calls).toHaveLength(1);
  });
  test.each(['plan', 'custom'] as const)('an incorrect read classification cannot relax the %s effect floor', async mode => {
    const f = fixture({ mode }); const result = await f.run(call());
    expect(result.success).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test('server read-only hints never grant an outward call under a read-only owner', async () => {
    const f = fixture({ mode: 'plan' }); f.setSchema({ ...initialSchema(), annotations: { readOnlyHint: true } });
    const result = await f.run(call()); expect(result.success).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test('accessor-backed transport ports are not advertised or invoked', () => {
    let reads = 0; const f = fixture(); resetAgentMcpCallRouteForTests();
    Object.defineProperty(f.api, 'callTool', { get() { reads++; return async () => 'forged'; }, configurable: true });
    expect(installAgentMcpCallRoute(f.registry, f.context)).toBe(false); expect(reads).toBe(0);
  });
  test.each(['blocked', 'disconnected', 'quarantined'] as const)('retains the native %s server restriction', async state => {
    const f = fixture(); f.setServers([{ ...initialServer(), ...(state === 'blocked' ? { trustMode: 'blocked' as const }
      : state === 'disconnected' ? { connected: false } : { schemaFreshness: 'quarantined' as const }) }]);
    const result = await f.run(call()); expect(result.success).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test.each(['missing', 'wrong-name'] as const)('holds %s schema without guessing the tool', async shape => {
    const f = fixture(); f.setSchema(shape === 'missing' ? null : { ...initialSchema(), name: 'other' });
    const result = await f.run(call()); expect(result.success).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test.each(['api', 'policy', 'source', 'port', 'schema'] as const)('a %s change during schema acquisition refuses dispatch', async changed => {
    const f = fixture(); f.beforeSchema(() => {
      if (changed === 'api') f.context.clients.mcpApi = { ...f.api };
      if (changed === 'policy') f.setServers([{ ...initialServer(), allowedHosts: ['changed.example'] }]);
      if (changed === 'source') f.source.goal = 'The synthetic source was revoked';
      if (changed === 'port') f.api.callTool = async () => 'replacement';
      if (changed === 'schema') f.setSchema({ ...initialSchema(), name: 'replaced' });
    });
    const result = await f.run(call()); expect(result.success).toBe(false); expect(f.calls).toHaveLength(0);
  });
  test.each(['policy', 'schema', 'revoked', 'cancelled'] as const)('native pre-send restriction refuses late %s state', async changed => {
    const f = fixture(); const controller = new AbortController(); f.beforeCall(() => {
      if (changed === 'policy') f.setServers([{ ...initialServer(), allowedPaths: ['/changed'] }]);
      if (changed === 'schema') { const schema = f.schema(); if (schema) schema.inputSchema.properties = { changed: { type: 'string' } }; }
      if (changed === 'revoked') f.setMode('plan');
      if (changed === 'cancelled') controller.abort();
    });
    const result = await f.run(call(), controller.signal).catch(() => undefined); expect(result?.success).not.toBe(true); expect(f.calls).toHaveLength(0);
  });
  test('a schema accessor replacement is rejected without executing the accessor', async () => {
    const f = fixture(); let reads = 0; f.beforeCall(() => {
      const schema = f.schema(); if (schema) Object.defineProperty(schema, 'inputSchema', { get() { reads++; return {}; }, configurable: true });
    });
    expect((await f.run(call())).success).toBe(false); expect(reads).toBe(0); expect(f.calls).toHaveLength(0);
  });
  test('a real nested child receives fresh recorded admission rather than caller flags', async () => {
    const f = fixture(); f.registry.register({ definition: { name: 'mcp_facade', description: 'Synthetic MCP facade.', parameters: { type: 'object', additionalProperties: true } },
      execute: (_args, options) => f.registry.executeNested('nested-synthetic-mcp', 'mcp', call(), options) });
    expect((await f.run({}, undefined, 'mcp_facade')).success).toBe(true); expect(f.calls).toHaveLength(1);
  });
  test('server errors expose no raw private server failure details', async () => {
    const f = fixture(); f.beforeCall(() => { throw new Error('synthetic-private-server-detail'); });
    const result = await f.run(call()); expect(result.success).toBe(false); expect(result.error).not.toContain('synthetic-private-server-detail');
  });
});
