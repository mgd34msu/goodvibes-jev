/**
 * G5, Permission Audit
 *
 * Verifies PermissionPromptUI rendering per category.
 */

import { describe, test, expect } from 'bun:test';
import { PermissionPromptUI } from '../../permissions/prompt.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { analyzePermissionRequest, type PermissionRequestAnalysis } from '@goodvibes-jev/engine/sdk/platform/permissions';

// ---------------------------------------------------------------------------
// 5. PermissionPromptUI, renders correct category label per category
// ---------------------------------------------------------------------------

/**
 * Rendering consumes the gate's explicit reading. analyzePermissionRequest
 * supplies only structural facts now; it no longer guesses a risk family from
 * a command or path. Keep those readings fixture data, not a replacement gate.
 */
function readAnalysis(
  tool: string,
  args: Record<string, unknown>,
  category: Parameters<typeof analyzePermissionRequest>[2],
  riskFamily: NonNullable<PermissionRequestAnalysis['riskFamily']>,
  facts: Pick<PermissionRequestAnalysis, 'riskLevel' | 'blastRadius' | 'sideEffects'>,
): PermissionRequestAnalysis {
  return { ...analyzePermissionRequest(tool, args, category), riskFamily, ...facts };
}

/** The permission dialog's text (a kit layer), one row per line. */
function promptText(width: number, request: Parameters<typeof PermissionPromptUI.createPromptLayer>[2]): string {
  return PermissionPromptUI.createPromptLayer(width + 40, 48, request).lines
    .map((line) => line.map((c) => c.char).join(''))
    .join('\n');
}

/** One fact row of the dialog: the label column, then the value. */
function fact(label: string, value: string): string {
  return `${label.padEnd(11)} ${value}`;
}

describe('PermissionPromptUI: renders correctly per category', () => {
  const WIDTH = 80;

  test('write category: label is WRITE, color is the theme warning token', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('write');
    expect(label).toBe('WRITE');
    expect(color).toBe(activeTokens().warning);
  });

  test('execute category: label is EXECUTE, color is the theme error token', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('execute');
    expect(label).toBe('EXECUTE');
    expect(color).toBe(activeTokens().error);
  });

  test('delegate category: label is DELEGATE, color is the theme blocked token', () => {
    const { label, color } = PermissionPromptUI.getCategoryLabel('delegate');
    expect(label).toBe('DELEGATE');
    expect(color).toBe(activeTokens().blocked);
  });

  test('read category: falls through to default PERMISSION label', () => {
    // read is auto-approved and never shown in a prompt, but getCategoryLabel is a pure function
    const { label } = PermissionPromptUI.getCategoryLabel('read' as Parameters<typeof PermissionPromptUI.getCategoryLabel>[0]);
    expect(label).toBe('PERMISSION');
  });

  test('createPromptLayer returns non-empty array of lines for write', () => {
    const request = {
      callId: 'test-call-1',
      tool: 'write',
      args: { path: 'src/output.ts' },
      category: 'write' as const,
      analysis: readAnalysis('write', { path: 'src/output.ts' }, 'write', 'file-mutation', { riskLevel: 'medium' }),
      resolve: (_approved: boolean) => {},
    };
    const layer = PermissionPromptUI.createPromptLayer(WIDTH, 24, request);
    expect(layer.lines.length).toBeGreaterThan(0);
  });

  test('createPromptLayer for execute includes EXECUTE label', () => {
    const request = {
      callId: 'test-call-2',
      tool: 'exec',
      args: { command: 'npm run build' },
      category: 'execute' as const,
      analysis: analyzePermissionRequest('exec', { command: 'npm run build' }, 'execute'),
      resolve: (_approved: boolean) => {},
    };
    expect(promptText(WIDTH, request)).toContain('execute');
  });

  test('createPromptLayer for delegate includes DELEGATE label', () => {
    const request = {
      callId: 'test-call-3',
      tool: 'agent',
      args: { task: 'do something' },
      category: 'delegate' as const,
      analysis: analyzePermissionRequest('agent', { task: 'do something' }, 'delegate'),
      resolve: (_approved: boolean) => {},
    };
    expect(promptText(WIDTH, request)).toContain('delegate');
  });

  test('createPromptLayer includes tool name in output', () => {
    const toolName = 'write';
    const request = {
      callId: 'test-call-4',
      tool: toolName,
      args: { path: 'out.ts' },
      category: 'write' as const,
      analysis: analyzePermissionRequest(toolName, { path: 'out.ts' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    expect(promptText(WIDTH, request)).toContain(toolName);
  });

  test('createPromptLayer includes choices [Y] Allow once in output', () => {
    const request = {
      callId: 'test-call-5',
      tool: 'exec',
      args: { command: 'ls' },
      category: 'execute' as const,
      analysis: analyzePermissionRequest('exec', { command: 'ls' }, 'execute'),
      resolve: (_approved: boolean) => {},
    };
    expect(promptText(WIDTH, request)).toContain('Allow once y');
  });

  test('createPromptLayer specializes execute prompts for shell execution', () => {
    const request = {
      callId: 'test-call-6',
      tool: 'exec',
      args: { command: 'bun run build' },
      category: 'execute' as const,
      analysis: readAnalysis('exec', { command: 'bun run build' }, 'execute', 'shell-mutation', { riskLevel: 'medium', blastRadius: 'project', sideEffects: ['changes state'] }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Shell Execution Approval');
    expect(text).toContain('Command');
    expect(text).toContain(fact('Decision', 'shell-execution'));
    expect(text).toContain(fact('Surface', 'shell  radius=project'));
    expect(text).toContain(fact('Effects', 'changes state'));
    expect(text).toContain(fact('Checklist', 'Confirm shell side effects'));
  });

  test('createPromptLayer specializes network prompts and includes host context', () => {
    const request = {
      callId: 'test-call-7',
      tool: 'fetch',
      args: { url: 'https://example.com/docs' },
      category: 'execute' as const,
      analysis: {
        classification: 'network',
        riskFamily: 'network-egress' as const,
        riskLevel: 'medium' as const,
        summary: 'Outbound network request',
        reasons: ['Review external host access before approval.'],
        target: 'https://example.com/docs',
        targetKind: 'url' as const,
        surface: 'network' as const,
        blastRadius: 'external' as const,
        sideEffects: ['outbound network access', 'remote content ingestion'],
        host: 'example.com',
      },
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Network Access Approval');
    expect(text).toContain('Host');
    expect(text).toContain('example.com');
    expect(text).toContain(fact('Decision', 'external-access'));
    expect(text).toContain(fact('Surface', 'network  radius=external'));
  });

  test('createPromptLayer specializes write prompts for file mutation review', () => {
    const request = {
      callId: 'test-call-8',
      tool: 'write',
      args: { path: 'src/output.ts' },
      category: 'write' as const,
      analysis: readAnalysis('write', { path: 'src/output.ts' }, 'write', 'file-mutation', { riskLevel: 'medium' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('File Mutation Approval');
    expect(text).toContain(fact('Decision', 'file-mutation'));
    expect(text).toContain(fact('Checklist', 'Confirm target path'));
  });

  test('createPromptLayer specializes notebook edits separately from generic file mutation', () => {
    const request = {
      callId: 'test-call-8b',
      tool: 'edit',
      args: { path: 'notebooks/analysis.ipynb' },
      category: 'write' as const,
      analysis: readAnalysis('edit', { path: 'notebooks/analysis.ipynb' }, 'write', 'notebook-edit', { riskLevel: 'medium' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Notebook Edit Approval');
    expect(text).toContain(fact('Decision', 'notebook-edit'));
    expect(text).toContain(fact('Checklist', 'Confirm notebook cell intent'));
  });

  test('createPromptLayer specializes config mutations separately from generic file mutation', () => {
    const request = {
      callId: 'test-call-8c',
      tool: 'write',
      args: { path: '.env.production' },
      category: 'write' as const,
      analysis: readAnalysis('write', { path: '.env.production' }, 'write', 'config-mutation', { riskLevel: 'high' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Configuration Mutation Approval');
    expect(text).toContain(fact('Decision', 'config-mutation'));
    expect(text).toContain(fact('Checklist', 'Confirm configuration blast radius'));
  });

  test('createPromptLayer specializes dependency installs separately from generic shell execution', () => {
    const request = {
      callId: 'test-call-8d',
      tool: 'exec',
      args: { command: 'bun install' },
      category: 'execute' as const,
      analysis: readAnalysis('exec', { command: 'bun install' }, 'execute', 'dependency-install', { riskLevel: 'high' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Dependency Install Approval');
    expect(text).toContain(fact('Decision', 'dependency-install'));
    expect(text).toContain(fact('Checklist', 'Confirm dependency provenance'));
  });

  test('createPromptLayer specializes delegation prompts for fan-out review', () => {
    const request = {
      callId: 'test-call-9',
      tool: 'agent',
      args: { task: 'delegate release verification' },
      category: 'delegate' as const,
      analysis: readAnalysis('agent', { task: 'delegate release verification' }, 'delegate', 'delegation', { riskLevel: 'high', blastRadius: 'delegated' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Agent Delegation Approval');
    expect(text).toContain(fact('Decision', 'delegation'));
    expect(text).toContain(fact('Surface', 'orchestration  radius=delegated'));
    expect(text).toContain(fact('Checklist', 'Confirm delegated scope'));
  });

  test('createPromptLayer specializes agent spawn approvals separately from generic delegation', () => {
    const request = {
      callId: 'test-call-9b',
      tool: 'agent',
      args: { mode: 'spawn', task: 'delegate release verification' },
      category: 'delegate' as const,
      analysis: readAnalysis('agent', { mode: 'spawn', task: 'delegate release verification' }, 'delegate', 'agent-spawn', { riskLevel: 'high', blastRadius: 'delegated' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Agent Spawn Approval');
    expect(text).toContain(fact('Decision', 'agent-spawn'));
    expect(text).toContain(fact('Checklist', 'Confirm spawned agent scope'));
  });

  test('createPromptLayer specializes remote dispatch approvals', () => {
    const request = {
      callId: 'test-call-10',
      tool: 'remote_trigger',
      args: { mode: 'dispatch', task: 'run remote verification' },
      category: 'delegate' as const,
      analysis: readAnalysis('remote_trigger', { mode: 'dispatch', task: 'run remote verification' }, 'delegate', 'remote-dispatch', { riskLevel: 'high' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Remote Dispatch Approval');
    expect(text).toContain(fact('Decision', 'remote-dispatch'));
    expect(text).toContain(fact('Checklist', 'Confirm remote target'));
  });

  test('createPromptLayer specializes MCP trust escalation approvals', () => {
    const request = {
      callId: 'test-call-11',
      tool: 'mcp',
      args: { mode: 'set-trust', serverName: 'docs', trustMode: 'allow-all' },
      category: 'delegate' as const,
      analysis: readAnalysis('mcp', { mode: 'set-trust', serverName: 'docs', trustMode: 'allow-all' }, 'delegate', 'mcp-escalation', { riskLevel: 'critical' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('MCP Trust Escalation Approval');
    expect(text).toContain(fact('Decision', 'mcp-escalation'));
    expect(text).toContain(fact('Checklist', 'Confirm server identity'));
  });

  test('createPromptLayer specializes hook execution approvals', () => {
    const request = {
      callId: 'test-call-12',
      tool: 'workflow',
      args: { eventPath: 'Pre:tool:edit', hookName: 'guard-edit' },
      category: 'delegate' as const,
      analysis: readAnalysis('workflow', { eventPath: 'Pre:tool:edit', hookName: 'guard-edit' }, 'delegate', 'hook-execution', { riskLevel: 'high' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Hook Execution Approval');
    expect(text).toContain(fact('Decision', 'hook-execution'));
    expect(text).toContain(fact('Checklist', 'Confirm hook source'));
  });

  test('createPromptLayer specializes plugin lifecycle approvals', () => {
    const request = {
      callId: 'test-call-13',
      tool: 'write',
      args: { path: '.goodvibes/plugins/deploy-audit/manifest.json' },
      category: 'write' as const,
      analysis: readAnalysis('write', { path: '.goodvibes/plugins/deploy-audit/manifest.json' }, 'write', 'plugin-lifecycle', { riskLevel: 'high' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Plugin Lifecycle Approval');
    expect(text).toContain(fact('Decision', 'plugin-lifecycle'));
    expect(text).toContain(fact('Checklist', 'Confirm package provenance'));
  });

  test('createPromptLayer specializes sandbox policy change approvals', () => {
    const request = {
      callId: 'test-call-14',
      tool: 'write',
      args: { path: 'sandbox.vmBackend' },
      category: 'write' as const,
      analysis: readAnalysis('write', { path: 'sandbox.vmBackend' }, 'write', 'sandbox-policy-change', { riskLevel: 'critical' }),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Sandbox Policy Change Approval');
    expect(text).toContain(fact('Decision', 'sandbox-policy-change'));
    expect(text).toContain(fact('Checklist', 'Confirm isolation-mode impact'));
  });

  test('an unread request stays generic instead of guessing its risk family from a path', () => {
    const request = {
      callId: 'test-call-unread',
      tool: 'write',
      args: { path: '.env.production' },
      category: 'write' as const,
      analysis: analyzePermissionRequest('write', { path: '.env.production' }, 'write'),
      resolve: (_approved: boolean) => {},
    };
    const text = promptText(WIDTH, request);
    expect(text).toContain('Generic Approval');
    expect(text).toContain(fact('Decision', 'generic'));
    expect(text).not.toContain('Configuration Mutation Approval');
  });

  test('getDisplayArg returns path when args has path', () => {
    const arg = PermissionPromptUI.getDisplayArg('write', { path: '/some/file.ts' });
    expect(arg).toBe('/some/file.ts');
  });

  test('getDisplayArg returns command when args has command', () => {
    const arg = PermissionPromptUI.getDisplayArg('exec', { command: 'npm test' });
    expect(arg).toBe('npm test');
  });

  test('getDisplayArg returns pattern when args has pattern', () => {
    const arg = PermissionPromptUI.getDisplayArg('find', { pattern: '*.ts' });
    expect(arg).toBe('*.ts');
  });

  test('getDisplayArg falls back to first string value', () => {
    const arg = PermissionPromptUI.getDisplayArg('state', { key: 'my-key' });
    expect(arg).toBe('my-key');
  });
});
