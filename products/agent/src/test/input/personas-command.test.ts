import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerPersonasRuntimeCommands } from '../../input/commands/personas-runtime.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function commandHarness(): {
  readonly registry: CommandRegistry;
  readonly out: string[];
  readonly ctx: CommandContext;
} {
  const root = makeProjectTempDir('goodvibes-agent-persona-command');
  const registry = new CommandRegistry();
  registerPersonasRuntimeCommands(registry);
  const out: string[] = [];
  const ctx = {
    print: (text: string) => out.push(text),
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    },
  } as unknown as CommandContext;
  return { registry, out, ctx };
}

describe('/personas command', () => {
  test('creates, lists, shows, activates, and clears a local persona', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('personas', [
      'create',
      '--name',
      'Travel Planner',
      '--description',
      'Plans practical travel.',
      '--body',
      'Compare options, constraints, and next actions.',
      '--tags',
      'travel,planning',
    ], ctx);
    await registry.execute('personas', ['list'], ctx);
    await registry.execute('personas', ['use', 'travel-planner'], ctx);
    await registry.execute('personas', ['active'], ctx);
    await registry.execute('personas', ['clear'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent persona travel-planner');
    expect(text).toContain('Travel Planner - Plans practical travel.');
    expect(text).toContain('Active Agent persona: Travel Planner');
    expect(text).toContain('Compare options');
    expect(text).toContain('Cleared active Agent persona');
  });

  test('requires explicit delete confirmation and rejects secret-looking content', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('personas', ['create', '--name', 'Ops', '--description', 'Ops behavior.', '--body', 'Inspect then act.'], ctx);
    await registry.execute('personas', ['delete', 'ops'], ctx);
    await registry.execute('personas', ['delete', 'ops', '--yes'], ctx);
    await registry.execute('personas', ['create', '--name', 'Bad', '--description', 'Bad.', '--body', 'api_key=secret-value'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Refusing to delete Agent persona ops without --yes');
    expect(text).toContain('Deleted Agent persona ops');
    expect(text).toContain('secret-looking');
  });

  test('preserves option-looking persona field values', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('personas', [
      'create',
      '--name',
      'Flag Aware',
      '--description',
      '--prefer-direct-constraints',
      '--body',
      '--ask before scheduling, sending, or changing services',
      '--tags=ops,flags',
    ], ctx);
    await registry.execute('personas', ['show', 'flag-aware'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent persona flag-aware');
    expect(text).toContain('--prefer-direct-constraints');
    expect(text).toContain('--ask before scheduling, sending, or changing services');
    expect(text).toContain('tags: ops, flags');
  });

  test('discovers and imports local persona markdown only after confirmation', async () => {
    const { registry, out, ctx } = commandHarness();
    const shellPaths = ctx.workspace?.shellPaths;
    if (!shellPaths) throw new Error('missing shell paths');
    const personaDir = join(shellPaths.workingDirectory, '.goodvibes', 'agent', 'personas', 'travel-planner');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'PERSONA.md'), [
      '---',
      'name: Travel Planner',
      'description: Plan trips from preferences and constraints.',
      'triggers: travel, trip',
      'tags: planning, personal',
      '---',
      'Collect destination, dates, budget, accessibility needs, and timing constraints.',
      'Produce options and ask before booking or messaging anyone.',
    ].join('\n'));
    const copiedAgentDir = join(shellPaths.workingDirectory, '.goodvibes', 'agents', 'reviewer');
    mkdirSync(copiedAgentDir, { recursive: true });
    writeFileSync(join(copiedAgentDir, 'AGENT.md'), [
      '---',
      'name: Coding Reviewer',
      'description: Copied coding agent file that must not become an Agent persona.',
      '---',
      'Review code and spawn fix work.',
    ].join('\n'));
    const legacyMarkerDir = join(shellPaths.workingDirectory, '.goodvibes', 'agent', 'personas', 'legacy-coding-agent');
    mkdirSync(legacyMarkerDir, { recursive: true });
    writeFileSync(join(legacyMarkerDir, 'AGENT.md'), [
      '---',
      'name: Legacy Coding Agent',
      'description: Legacy marker that must not be treated as an Agent persona.',
      '---',
      'Act like a coding agent.',
    ].join('\n'));

    await registry.execute('personas', ['discover'], ctx);
    await registry.execute('personas', ['import-discovered', 'Travel', 'Planner'], ctx);
    await registry.execute('personas', ['list'], ctx);
    await registry.execute('personas', ['import-discovered', 'travel-planner', '--use', '--yes'], ctx);
    await registry.execute('personas', ['active'], ctx);
    await registry.execute('personas', ['show', 'travel-planner'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Discovered Agent persona files (1)');
    expect(text).toContain('Travel Planner  project-local');
    expect(text).not.toContain('Coding Reviewer');
    expect(text).not.toContain('Legacy Coding Agent');
    expect(text).toContain('Agent persona import preview');
    expect(text).toContain('No local Agent personas yet');
    expect(text).toContain('Imported Agent persona travel-planner: Travel Planner (active)');
    expect(text).toContain('active: yes');
    expect(text).toContain('Collect destination, dates, budget');
    expect(text).toContain('tags: planning, personal');
    expect(text).toContain('triggers: travel, trip');
  });
});
