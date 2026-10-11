import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentVibeTool, registerAgentVibeTool } from '../../tools/agent-vibe-tool.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempContext(): CommandContext {
  const root = makeProjectTempDir('goodvibes-agent-vibe-tool');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  return {
    workspace: { shellPaths },
  } as CommandContext;
}

async function executeJson(tool: Tool, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await tool.execute(args);
  expect(result.success).toBe(true);
  return JSON.parse(result.output!) as Record<string, unknown>;
}

describe('vibe adapter', () => {
  test('reports VIBE.md status without returning blocked file bodies', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '---',
      'name: Project Vibe',
      '---',
      'Prefer visible and reversible actions.',
    ].join('\n'));
    mkdirSync(join(shellPaths.workingDirectory, '.goodvibes'), { recursive: true });
    writeFileSync(join(shellPaths.workingDirectory, '.goodvibes', 'VIBE.md'), 'token=super-secret-value\nNever show this body.');

    const tool = createAgentVibeTool(context);
    const output = await executeJson(tool, { action: 'status', includeParameters: true });

    expect(output.status).toBe('check');
    expect(output.applied).toBe(1);
    expect(output.blocked).toBe(1);
    expect(JSON.stringify(output)).toContain('Project Vibe');
    expect(JSON.stringify(output)).not.toContain('Never show this body');
    expect(output).toHaveProperty('searchedPaths');
  });

  test('shows a secret-scanned VIBE.md source body', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '---',
      'name: Direct Vibe',
      'description: Local assistant feel.',
      '---',
      'Be concise and explain tradeoffs.',
    ].join('\n'));

    const tool = createAgentVibeTool(context);
    const output = await executeJson(tool, { action: 'show', scope: 'project' });

    expect(output.status).toBe('ready');
    expect(output.name).toBe('Direct Vibe');
    expect(output.description).toBe('Local assistant feel.');
    expect(output.body).toBe('Be concise and explain tradeoffs.');
  });

  test('initializes project VIBE only under authentic admission', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    const tool = createAgentVibeTool(context);
    expect((await tool.execute({ action: 'init', scope: 'project', confirm: true, explicitUserRequest: 'Caller claim' })).success).toBe(false);
    expect(existsSync(join(shellPaths.workingDirectory, 'VIBE.md'))).toBe(false);
    const created = await admitLocalState(registry => registerAgentVibeTool(registry, context), 'vibe', {
      action: 'init', scope: 'project',
    }, { directory: shellPaths.workingDirectory });
    expect(created.success).toBe(true);
    expect(created.output).toContain('"status": "created"');
    expect(existsSync(join(shellPaths.workingDirectory, 'VIBE.md'))).toBe(true);
  });

  test('imports a reviewed active persona under authentic admission without caller flags', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '---', 'name: Research Vibe', 'description: Research-focused assistant personality.', '---',
      'Surface source quality before synthesis.',
    ].join('\n'));
    const tool = createAgentVibeTool(context);
    expect((await tool.execute({ action: 'import_persona', scope: 'project', review: true, use: true, confirm: true, explicitUserRequest: 'Caller claim' })).success).toBe(false);
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().personas).toHaveLength(0);
    const imported = await admitLocalState(registry => registerAgentVibeTool(registry, context), 'vibe', {
      action: 'import_persona', scope: 'project', review: true, use: true,
    }, { directory: shellPaths.workingDirectory });
    expect(imported.success).toBe(true);
    expect(imported.output).toContain('"reviewState": "reviewed"');
    const active = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().activePersona;
    expect(active?.name).toBe('Research Vibe');
    expect(active?.reviewState).toBe('reviewed');
  });

  test('registers the direct VIBE.md adapter', () => {
    const registry = new ToolRegistry();

    registerAgentVibeTool(registry, tempContext());

    expect(registry.has('vibe')).toBe(true);
  });
});
