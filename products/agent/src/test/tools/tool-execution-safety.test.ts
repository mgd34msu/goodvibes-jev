import { describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { installToolExecutionSafetyGuard } from '../../tools/tool-execution-safety.ts';

function throwingTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} throws for safety regression coverage`,
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => {
      throw new Error(`${name} exploded`);
    },
  };
}

function okTool(name: string): Tool {
  return {
    definition: {
      name,
      description: `${name} succeeds for safety regression coverage`,
      parameters: { type: 'object', properties: {} },
    },
    execute: async () => ({ success: true, output: `${name} ok` }),
  };
}

describe('tool execution safety guard', () => {
  test('converts registered tool exceptions into failed tool results', async () => {
    const registry = new ToolRegistry();
    registry.register(throwingTool('broken'));
    installToolExecutionSafetyGuard(registry);

    const result = await registry.execute('call-broken', 'broken', {});
    expect(result).toMatchObject({
      callId: 'call-broken',
      success: false,
      error: 'broken exploded',
    });
  });

  test('wraps tools registered after the guard is installed', async () => {
    const registry = new ToolRegistry();
    installToolExecutionSafetyGuard(registry);
    registry.register(throwingTool('late_broken'));

    const result = await registry.execute('call-late', 'late_broken', {});
    expect(result.success).toBe(false);
    expect(result.error).toContain('late_broken exploded');
  });

  test('leaves successful tool results unchanged', async () => {
    const registry = new ToolRegistry();
    registry.register(okTool('healthy'));
    installToolExecutionSafetyGuard(registry);

    const result = await registry.execute('call-ok', 'healthy', {});
    expect(result).toMatchObject({
      callId: 'call-ok',
      success: true,
      output: 'healthy ok',
    });
  });
});

test('late registration preserves required input projection before execution', async () => {
  const registry = new ToolRegistry();
  installToolExecutionSafetyGuard(registry);
  let executions = 0;
  const tool = okTool('protected_late');
  tool.execute = async () => { executions++; return { success: true, output: 'not reached' }; };
  registry.register(tool, { inputProjection: null });
  await expect(registry.execute('held-call', 'protected_late', {})).rejects.toThrow('unconfigured');
  expect(executions).toBe(0);
});

test('late registration projects inputs and drains the registered owner', async () => {
  const registry = new ToolRegistry();
  installToolExecutionSafetyGuard(registry);
  const seen: unknown[] = [];
  let released = 0;
  const tool = okTool('projected_late');
  tool.execute = async args => { seen.push(args); return { success: true }; };
  registry.register(tool, { inputProjection: { async project() {
    return { status: 'projected', args: {}, release: async () => { released++; } };
  } } });
  const result = await registry.execute('projected-call', 'projected_late', { original: 'synthetic-private' });
  expect(result.success).toBe(true);
  expect(seen).toEqual([{}]);
  expect(released).toBe(1);
});
