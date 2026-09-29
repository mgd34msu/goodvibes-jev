// The mcp tool's approve-quarantine records who approved from the turn the
// call belongs to (the owner, or the surface the turn arrived on), never from
// an operatorId the model writes into the arguments.
import { describe, expect, test } from 'bun:test';
import { createMcpTool } from '../sdk/src/platform/tools/mcp/index.ts';
import { withTurnSurface } from '../sdk/src/platform/security/turn-boundary.ts';
import type { McpRegistry } from '../sdk/src/platform/mcp/registry.ts';

function toolWithRecorder() {
  const approvals: Array<[string, string]> = [];
  const registry = { approveSchemaQuarantine: (server: string, operator: string) => { approvals.push([server, operator]); } } as unknown as McpRegistry;
  return { tool: createMcpTool(registry), approvals };
}

describe('mcp approve-quarantine approver', () => {
  test('owner-direct input records the owner', async () => {
    const { tool, approvals } = toolWithRecorder();
    const result = await tool.execute({ mode: 'approve-quarantine', serverName: 'docs' });
    expect(result.success).toBe(true);
    expect(approvals).toEqual([['docs', 'owner']]);
  });

  test('a turn from a surface records that surface', async () => {
    const { tool, approvals } = toolWithRecorder();
    await withTurnSurface({ surface: 'telegram' }, () => tool.execute({ mode: 'approve-quarantine', serverName: 'docs' }));
    expect(approvals).toEqual([['docs', 'surface:telegram']]);
  });

  test('an operatorId in the arguments is not a parameter and names no one', async () => {
    const { tool, approvals } = toolWithRecorder();
    expect(tool.definition.parameters.properties).not.toHaveProperty('operatorId');
    await tool.execute({ mode: 'approve-quarantine', serverName: 'docs', operatorId: 'operator-henry' });
    expect(approvals.map(([, operator]) => operator)).not.toContain('operator-henry');
  });
});
