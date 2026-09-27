// Ported from goodvibes-agent src/test/runtime/mcp/permissions-coherence.test.ts.
//
// The engine reads each MCP call's capability through Jev (the side-effect
// battery's `capability` question) instead of a keyword match over tool names,
// so evaluateToolCall is asynchronous and these tests answer that question
// with a fake port. The role, scope and trust-mode rules under test stay code.
import { describe, expect, test } from 'bun:test';
import { McpPermissionManager } from '../sdk/src/platform/runtime/mcp/index.ts';
import { useGateReadings } from './_helpers/gate-readings.ts';

const readings = useGateReadings([
  ['write_file', { capability: 'write_fs' }],
  ['exec_shell', { capability: 'exec' }],
  ['read_docs', { capability: 'read_fs' }],
]);

describe('McpPermissionManager coherence evaluation', () => {
  test('constrained docs server denies incoherent write request', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained' });
    const result = await manager.evaluateToolCall('docs', 'write_file', { path: '/tmp/output.md' });
    expect(result.allowed).toBe(false);
    expect(result.verdict).toBe('deny');
    expect(result.incoherent).toBe(true);
    expect(readings.requests).toHaveLength(1);
  });

  test('ask-on-risk server asks for high-risk coherent request', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('fs', 'standard', { role: 'filesystem', mode: 'ask-on-risk', allowedPaths: ['/workspace'] });
    const result = await manager.evaluateToolCall('fs', 'write_file', { path: '/workspace/file.txt' });
    expect(result.allowed).toBe(false);
    expect(result.verdict).toBe('ask');
    expect(result.incoherent).toBe(false);
  });

  test('allow-all bypasses coherence denial while still surfacing risk metadata', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('elevated', 'trusted', { role: 'docs', mode: 'allow-all' });
    const result = await manager.evaluateToolCall('elevated', 'exec_shell', { command: 'rm -rf /tmp/x' });
    expect(result.allowed).toBe(true);
    expect(result.verdict).toBe('allow');
    expect(result.profileMode).toBe('allow-all');
    expect(result.capability).toBe('exec');
  });

  test('records recent MCP decisions with risk metadata', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'constrained' });
    await manager.evaluateToolCall('docs', 'read_docs', { path: '/workspace/README.md' });
    await manager.evaluateToolCall('docs', 'write_file', { path: '/workspace/out.md' });

    const decisions = manager.listRecentDecisions();
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.toolName).toBe('write_file');
    expect(decisions[0]?.verdict).toBe('deny');
    expect(decisions[0]?.capability).toBe('write_fs');
    expect(decisions[1]?.toolName).toBe('read_docs');
    expect(decisions[1]?.riskLevel).toBe('medium');
  });

  test('buildAttackPathReview surfaces posture and incoherent decisions', async () => {
    const manager = new McpPermissionManager();
    manager.registerServer('docs', 'standard', { role: 'docs', mode: 'allow-all' });
    manager.registerServer('ops', 'standard', { role: 'ops', mode: 'ask-on-risk', allowedPaths: ['/srv'] });
    await manager.evaluateToolCall('docs', 'write_file', { path: '/workspace/out.md' });

    const review = manager.buildAttackPathReview([
      {
        name: 'docs',
        role: 'docs',
        trustMode: 'allow-all',
        allowedPaths: [],
        allowedHosts: ['docs.example.com'],
        schemaFreshness: 'fresh',
        connected: true,
      },
      {
        name: 'ops',
        role: 'ops',
        trustMode: 'ask-on-risk',
        allowedPaths: ['/srv'],
        allowedHosts: [],
        schemaFreshness: 'quarantined',
        quarantineReason: 'operator_flagged',
        quarantineDetail: 'unexpected deploy surface',
        connected: false,
      },
    ], manager.listRecentDecisions());

    expect(review.totalServers).toBe(2);
    expect(review.allowAllServers).toBe(1);
    expect(review.quarantinedServers).toBe(1);
    expect(review.incoherentFindings).toBeGreaterThan(0);
    expect(review.criticalFindings).toBeGreaterThan(0);
    expect(review.summary).toContain('incoherent decision');
    const opsFinding = review.findings.find((finding) => finding.serverName === 'ops');
    expect(opsFinding?.severity).toBe('critical');
    expect(review.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'recent-decision', incoherent: true }),
    ]));
  });
});
