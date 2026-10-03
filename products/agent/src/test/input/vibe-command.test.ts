import { describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerVibeRuntimeCommands } from '../../input/commands/vibe-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function commandHarness(): {
  readonly registry: CommandRegistry;
  readonly out: string[];
  readonly ctx: CommandContext;
} {
  const root = makeProjectTempDir('goodvibes-agent-vibe-command');
  const registry = new CommandRegistry();
  registerVibeRuntimeCommands(registry);
  const out: string[] = [];
  const ctx = {
    print: (text: string) => out.push(text),
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    },
  } as unknown as CommandContext;
  return { registry, out, ctx };
}

describe('/vibe command', () => {
  test('previews, creates, shows, and imports VIBE.md as a reviewed active persona', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('vibe', ['status'], ctx);
    await registry.execute('vibe', ['init'], ctx);
    await registry.execute('vibe', ['init', '--yes'], ctx);
    await registry.execute('vibe', ['show', 'project'], ctx);
    await registry.execute('vibe', ['import-persona', 'project'], ctx);
    await registry.execute('vibe', ['import-persona', 'project', '--review', '--use', '--yes'], ctx);

    const text = out.join('\n');
    expect(text).toContain('GoodVibes Agent VIBE.md');
    expect(text).toContain('VIBE.md init preview');
    expect(text).toContain('confirmationRoutes');
    expect(text).toContain('vibe action:"init" scope:"project" confirm:true explicitUserRequest:"..."');
    expect(text).toContain('/vibe init --yes');
    expect(text).toContain('Created project VIBE.md');
    expect(text).toContain('Project VIBE.md');
    expect(text).toContain('VIBE.md persona import preview');
    expect(text).toContain('vibe action:"import_persona" reference:"project" name:"Project Vibe" description:"Imported project VIBE.md personality instructions." confirm:true explicitUserRequest:"..."');
    expect(text).toContain('/vibe import-persona "project" --name "Project Vibe" --description "Imported project VIBE.md personality instructions." --yes');
    expect(text).toContain('Imported VIBE.md persona project-vibe');
    expect(text).toContain('reviewed yes');
    expect(text).toContain('active yes');

    const shellPaths = ctx.workspace?.shellPaths;
    if (!shellPaths) throw new Error('missing shell paths');
    const snapshot = AgentPersonaRegistry.fromShellPaths(shellPaths).snapshot();
    expect(snapshot.activePersona?.id).toBe('project-vibe');
    expect(snapshot.activePersona?.reviewState).toBe('reviewed');
  });

  test('reports secret-looking VIBE.md files without importing them', async () => {
    const { registry, out, ctx } = commandHarness();
    const shellPaths = ctx.workspace?.shellPaths;
    if (!shellPaths) throw new Error('missing shell paths');
    writeFileSync(join(shellPaths.workingDirectory, 'VIBE.md'), 'api_key=secret-value\nDo not load this.');

    await registry.execute('vibe', ['status'], ctx);
    await registry.execute('vibe', ['import-persona', 'project', '--yes'], ctx);

    const text = out.join('\n');
    expect(text).toContain('blocked 1');
    expect(text).toContain('secret-looking');
    expect(text).toContain('Cannot import VIBE.md');
    expect(text).not.toContain('Do not load this.');
  });
});
