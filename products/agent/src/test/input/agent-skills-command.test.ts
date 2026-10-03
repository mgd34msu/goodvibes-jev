import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerAgentSkillsRuntimeCommands } from '../../input/commands/agent-skills-runtime.ts';
import { registerBuiltinCommands } from '../../input/commands.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function commandHarness(): {
  readonly registry: CommandRegistry;
  readonly out: string[];
  readonly ctx: CommandContext;
} {
  const root = makeProjectTempDir('goodvibes-agent-skill-command');
  const registry = new CommandRegistry();
  registerAgentSkillsRuntimeCommands(registry);
  const out: string[] = [];
  const ctx = {
    print: (text: string) => out.push(text),
    workspace: {
      shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
    },
  } as unknown as CommandContext;
  return { registry, out, ctx };
}

describe('/agent-skills command', () => {
  test('creates, lists, enables, shows, and disables a local skill', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('agent-skills', [
      'create',
      '--name',
      'Inbox Triage',
      '--description',
      'Prioritize messages without sending replies.',
      '--procedure',
      'Summarize senders, urgency, and next actions. Do not send external messages.',
      '--tags',
      'ops,communication',
      '--requires-env',
      'GOODVIBES_AGENT_TEST_MISSING_TOKEN',
      '--requires-command',
      'definitely-missing-goodvibes-agent-test-bin',
    ], ctx);
    await registry.execute('agent-skills', ['enable', 'inbox-triage'], ctx);
    await registry.execute('agent-skills', ['attention'], ctx);
    await registry.execute('agent-skills', ['enabled'], ctx);
    await registry.execute('agent-skills', ['show', 'inbox-triage'], ctx);
    await registry.execute('agent-skills', ['disable', 'inbox-triage'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent skill inbox-triage');
    expect(text).toContain('Enabled Agent skill inbox-triage');
    expect(text).toContain('needs env:GOODVIBES_AGENT_TEST_MISSING_TOKEN,command:definitely-missing-goodvibes-agent-test-bin');
    expect(text).toContain('missing: env:GOODVIBES_AGENT_TEST_MISSING_TOKEN, command:definitely-missing-goodvibes-agent-test-bin');
    expect(text).toContain('Inbox Triage - Prioritize messages');
    expect(text).toContain('Do not send external messages');
    expect(text).toContain('Disabled Agent skill inbox-triage');
  });

  test('requires explicit delete confirmation and rejects secret-looking procedure content', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('agent-skills', ['create', '--name', 'Ops', '--description', 'Ops procedure.', '--procedure', 'Inspect then act.'], ctx);
    await registry.execute('agent-skills', ['delete', 'ops'], ctx);
    await registry.execute('agent-skills', ['delete', 'ops', '--yes'], ctx);
    await registry.execute('agent-skills', ['create', '--name', 'Bad', '--description', 'Bad.', '--procedure', 'token=super-secret-value'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Refusing to delete Agent skill ops without --yes');
    expect(text).toContain('Deleted Agent skill ops');
    expect(text).toContain('secret-looking');
  });

  test('preserves option-looking skill procedure values', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('agent-skills', [
      'create',
      '--name',
      'Flag Procedure',
      '--description=Capture command-line guidance.',
      '--procedure',
      '--dry-run first, then ask before external writes.',
      '--tags=cli,flags',
    ], ctx);
    await registry.execute('agent-skills', ['show', 'flag-procedure'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent skill flag-procedure');
    expect(text).toContain('Capture command-line guidance.');
    expect(text).toContain('--dry-run first, then ask before external writes.');
    expect(text).toContain('tags: cli, flags');
  });

  test('creates and enables local skill bundles', async () => {
    const { registry, out, ctx } = commandHarness();

    await registry.execute('agent-skills', [
      'create',
      '--name',
      'Briefing',
      '--description',
      'Summarize status.',
      '--procedure',
      'Review state and report next actions.',
      '--requires-env',
      'GOODVIBES_AGENT_TEST_MISSING_TOKEN',
    ], ctx);
    await registry.execute('agent-skills', ['create', '--name', 'Approvals', '--description', 'Review approvals.', '--procedure', 'Explain pending approval risk and decision.'], ctx);
    await registry.execute('agent-skills', [
      'bundle',
      'create',
      '--name',
      'Operator Pack',
      '--description',
      'Use briefing and approval review together.',
      '--skills',
      'briefing,approvals',
    ], ctx);
    await registry.execute('agent-skills', ['bundle', 'enable', 'operator-pack'], ctx);
    await registry.execute('agent-skills', ['bundle', 'enabled'], ctx);
    await registry.execute('agent-skills', ['bundle', 'attention'], ctx);
    await registry.execute('agent-skills', ['bundle', 'show', 'operator-pack'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent skill bundle operator-pack');
    expect(text).toContain('Enabled Agent skill bundle operator-pack');
    expect(text).toContain('Operator Pack - Use briefing and approval review together.');
    expect(text).toContain('needs env:GOODVIBES_AGENT_TEST_MISSING_TOKEN');
    expect(text).toContain('Agent Skill Bundles needing setup');
    expect(text).toContain('readiness: needs setup');
    expect(text).toContain('missing: env:GOODVIBES_AGENT_TEST_MISSING_TOKEN');
    expect(text).toContain('active skills: 2');
    expect(text).toContain('- briefing: Briefing');
    expect(text).toContain('- approvals: Approvals');
  });

  test('discovers and imports local SKILL.md files only after confirmation', async () => {
    const { registry, out, ctx } = commandHarness();
    const shellPaths = ctx.workspace?.shellPaths;
    if (!shellPaths) throw new Error('missing shell paths');
    const skillDir = join(shellPaths.workingDirectory, '.goodvibes', 'agent', 'skills', 'travel-planner');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: Travel Planner',
      'description: Plan trips from preferences and constraints.',
      'triggers: travel, trip',
      'tags: planning, personal',
      '---',
      'Collect destination, dates, budget, accessibility needs, and timing constraints.',
      'Produce options and ask before booking or messaging anyone.',
    ].join('\n'));

    await registry.execute('agent-skills', ['discover'], ctx);
    await registry.execute('agent-skills', ['import-discovered', 'Travel', 'Planner'], ctx);
    // --enabled is ignored; the skill is always imported disabled for review-first policy
    await registry.execute('agent-skills', ['import-discovered', 'travel-planner', '--enabled', '--yes'], ctx);
    await registry.execute('agent-skills', ['enabled'], ctx);
    await registry.execute('agent-skills', ['show', 'travel-planner'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Discovered Agent skill files (1)');
    expect(text).toContain('Travel Planner  project-local');
    expect(text).toContain('Agent skill import preview');
    expect(text).toContain('Imported Agent skill travel-planner');
    // skill is always imported disabled regardless of --enabled flag
    expect(text).toContain('enabled no');
    expect(text).toContain('imported disabled');
    expect(text).toContain('review pending');
    // the enabled list should NOT include the unreviewed skill
    expect(text).not.toContain('travel-planner  enabled');
    expect(text).toContain('Collect destination, dates, budget');
    expect(text).toContain('tags: planning, personal');
    expect(text).toContain('triggers: travel, trip');
  });

  test('/skills local routes to Agent-local skills through the Agent command registry', async () => {
    const root = makeProjectTempDir('goodvibes-agent-skill-local-alias');
    const registry = new CommandRegistry();
    registerBuiltinCommands(registry);
    const out: string[] = [];
    const ctx = {
      print: (text: string) => out.push(text),
      workspace: {
        shellPaths: createShellPathService({ workingDirectory: root, homeDirectory: root }),
      },
    } as unknown as CommandContext;

    expect(registry.get('skills')?.name).toBe('skills');
    expect(registry.get('agent-skills')?.name).toBe('skills');
    await registry.execute('skills', ['local', 'create', '--name', 'Prep', '--description', 'Prepare context.', '--procedure', 'Read current state first.'], ctx);
    await registry.execute('skills', ['local', 'list'], ctx);

    const text = out.join('\n');
    expect(text).toContain('Created Agent skill prep');
    expect(text).toContain('Prep - Prepare context.');
  });
});
