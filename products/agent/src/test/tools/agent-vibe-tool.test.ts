import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import type { CommandContext } from '../../input/command-registry.ts';
import { createAgentVibeTool, registerAgentVibeTool } from '../../tools/agent-vibe-tool.ts';
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

  test('previews and confirms project VIBE.md initialization', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    const tool = createAgentVibeTool(context);

    const preview = await executeJson(tool, { action: 'init', scope: 'project' });
    expect(preview.status).toBe('confirmation_required');
    expect(preview.path).toBe(join(shellPaths.workingDirectory, 'VIBE.md'));
    expect(preview.confirmationRoutes).toEqual(expect.objectContaining({
      model: 'vibe action:"init" scope:"project" confirm:true explicitUserRequest:"..."',
      cli: '/vibe init --yes',
    }));
    expect(existsSync(join(shellPaths.workingDirectory, 'VIBE.md'))).toBe(false);

    const created = await executeJson(tool, {
      action: 'init',
      scope: 'project',
      confirm: true,
      explicitUserRequest: 'Create a project VIBE.md.',
    });
    expect(created.status).toBe('created');
    expect(existsSync(join(shellPaths.workingDirectory, 'VIBE.md'))).toBe(true);
  });

  test('imports VIBE.md into a reviewed active persona only after confirmation', async () => {
    const context = tempContext();
    const shellPaths = context.workspace.shellPaths!;
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), [
      '---',
      'name: Research Vibe',
      'description: Research-focused assistant personality.',
      '---',
      'Surface source quality before synthesis.',
    ].join('\n'));
    const tool = createAgentVibeTool(context);

    const preview = await executeJson(tool, { action: 'import_persona', scope: 'project', review: true, use: true });
    expect(preview.status).toBe('confirmation_required');
    expect(preview.name).toBe('Research Vibe');
    expect(preview.confirmationRoutes).toEqual(expect.objectContaining({
      model: 'vibe action:"import_persona" reference:"project" name:"Research Vibe" description:"Research-focused assistant personality." review:true use:true confirm:true explicitUserRequest:"..."',
      cli: '/vibe import-persona "project" --name "Research Vibe" --description "Research-focused assistant personality." --review --use --yes',
    }));
    expect(AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot().personas).toHaveLength(0);

    const imported = await executeJson(tool, {
      action: 'import_persona',
      scope: 'project',
      review: true,
      use: true,
      confirm: true,
      explicitUserRequest: 'Import this VIBE.md as my active reviewed persona.',
    });
    expect(imported.status).toBe('imported');
    expect(imported.persona).toEqual(expect.objectContaining({
      id: 'research-vibe',
      name: 'Research Vibe',
      reviewState: 'reviewed',
      active: true,
    }));

    const snapshot = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
    expect(snapshot.activePersona?.name).toBe('Research Vibe');
  });

  test('registers the direct VIBE.md adapter', () => {
    const registry = new ToolRegistry();

    registerAgentVibeTool(registry, tempContext());

    expect(registry.has('vibe')).toBe(true);
  });
});
