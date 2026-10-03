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
