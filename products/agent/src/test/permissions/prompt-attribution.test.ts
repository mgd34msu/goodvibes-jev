import { describe, expect, test } from 'bun:test';
import { PermissionPromptUI, type PermissionRequest } from '../../permissions/prompt.ts';

function baseRequest(attribution?: PermissionRequest['attribution']): PermissionRequest {
  return {
    callId: 'call-1',
    tool: 'exec',
    args: { command: 'ls' },
    category: 'execute',
    analysis: {
      classification: 'execute',
      riskLevel: 'medium',
      summary: 'Run a shell command',
      reasons: ['Review the command before approving.'],
      target: 'ls',
      targetKind: 'command',
    },
    workingDirectory: '/repo',
    ...(attribution ? { attribution } : {}),
    resolve: () => {},
  };
}

function renderedText(request: PermissionRequest): string {
  return PermissionPromptUI.createPromptLayer(120, 40, request).lines.map((line) => line.map((cell) => cell.char).join('')).join('\n');
}

/** Fact rows the dialog lists for a request. */
function factCount(request: PermissionRequest): number {
  return PermissionPromptUI.promptFacts(request).length;
}

describe('PermissionPromptUI attribution rendering (SDK 1.6.1 PermissionAttribution union)', () => {
  test('no attribution (foreground ask): no "Asked by" row, one fewer fact than an attributed ask', () => {
    const request = baseRequest();
    expect(renderedText(request)).not.toContain('Asked by');
    expect(factCount(baseRequest({ kind: 'mcp-server', serverName: 'docs-server' }))).toBe(factCount(request) + 1);
  });

  test('mcp-server attribution renders which server issued the elicitation', () => {
    const request = baseRequest({ kind: 'mcp-server', serverName: 'docs-server' });
    const text = renderedText(request);
    expect(text).toContain('Asked by');
    expect(text).toContain('MCP server: docs-server');
  });

  test('sandbox-escalation attribution renders the sandbox and the specific escalations named', () => {
    const request = baseRequest({ kind: 'sandbox-escalation', sandbox: 'exec-sandbox', escalations: ['wants-network', 'wants-host-privilege'] });
    const text = renderedText(request);
    expect(text).toContain('Asked by');
    expect(text).toContain('Sandbox exec-sandbox: wants-network, wants-host-privilege');
  });

  test('background-agent attribution renders no "Asked by" row: it is attributed via fleet metadata.agentId instead', () => {
    const request = baseRequest({ kind: 'background-agent', agentId: 'agent-123', template: 'engineer' });
    const text = renderedText(request);
    expect(text).not.toContain('Asked by');
    expect(factCount(request)).toBe(factCount(baseRequest()));
  });
});
