// Ported from goodvibes-agent src/test/runtime/mcp/permissions-coherence.test.ts.
//
// The engine reads each MCP call's capability through Jev (the side-effect
// battery's `capability` question) instead of a keyword match over tool names,
// and its stakes through the gate's reading (in place of the fixed
// capability-to-risk table), so evaluateToolCall is asynchronous and these
// tests answer those questions with a fake port. The role, scope and trust-mode rules under test stay code.
import { describe, expect, test } from 'bun:test';
import { McpPermissionManager } from '../sdk/src/platform/runtime/mcp/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

const readings = useGateReadings([
  ['write_file', { capability: 'write_fs', mutates: true, beyondProject: true }],
  ['exec_shell', { capability: 'exec', mutates: true, irreversible: true }],
  ['read_docs', { capability: 'read_fs', mutates: false }],
]);

describe('MCP tool permissions', () => {
  test('role and old risk modes do not require a Jev permission decision', async () => {
    for (const mode of ['constrained', 'ask-on-risk', 'allow-all'] as const) {
      const manager = new McpPermissionManager();
      manager.registerServer('fixture', 'standard', { role: 'docs', mode });
      const result = await manager.evaluateToolCall('fixture', 'write_file', { path: '/tmp/output.md' });
      expect(result.allowed).toBe(true);
      expect(result.riskLevel).toBeUndefined();
      expect(result.judgmentDecisionIds).toBeUndefined();
    }
    expect(readings.requests.filter(request => 'capability' in (request.questions ?? {}) || 'mutates' in (request.questions ?? {}))).toHaveLength(0);
  });
  test('explicit tool denies and configured path scope remain authoritative', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('fixture', 'standard', { allowedPaths: ['/workspace'] });
    expect((await manager.evaluateToolCall('fixture', 'read_file', { path: '/workspace/file' })).allowed).toBe(true);
    expect((await manager.evaluateToolCall('fixture', 'read_file', { path: '/elsewhere/file' })).allowed).toBe(false);
    manager.denyTool('fixture', 'read_file');
    expect((await manager.evaluateToolCall('fixture', 'read_file', { path: '/workspace/file' })).allowed).toBe(false);
  });
});
