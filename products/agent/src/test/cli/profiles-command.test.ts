import { describe, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { readAgentRuntimeProfileSelection } from '../../agent/runtime-profile.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

async function runProfilesCli(args: readonly string[], homeDirectory: string) {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: homeDirectory, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory: homeDirectory,
      homeDirectory,
    });
    return {
      result,
      output: output.join('\n'),
    };
  } finally {
    console.log = originalLog;
  }
}

describe('profiles CLI command', () => {
  test('parses profiles command and --agent-profile flag', () => {
    const parsed = parseGoodVibesCli(['--agent-profile', 'household', 'status']);
    expect(parsed.flags.agentProfile).toBe('household');
    expect(parsed.command).toBe('status');

    const inline = parseGoodVibesCli(['--agent-profile=travel', 'profiles', 'list']);
    expect(inline.flags.agentProfile).toBe('travel');
    expect(inline.command).toBe('profiles');

    const profiles = parseGoodVibesCli(['profiles', 'list']);
    expect(profiles.command).toBe('profiles');
  });

  test('creates, lists, shows, and deletes Agent profiles with confirmation', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-cli');

    const refused = await runProfilesCli(['profiles', 'create', 'Household'], home);
    expect(refused.result.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const created = await runProfilesCli(['profiles', 'create', 'Household', '--yes'], home);
    expect(created.result.exitCode).toBe(0);
    expect(created.output).toContain('Agent profile created: household');
    expect(created.output).toContain('goodvibes-agent --agent-profile household');

    const listed = await runProfilesCli(['profiles', 'list'], home);
    expect(listed.output).toContain('Agent profiles (1)');
    expect(listed.output).toContain('household');

    const shown = await runProfilesCli(['profiles', 'show', 'household'], home);
    expect(shown.output).toContain('Agent profile: household');

    const shownJson = await runProfilesCli(['profiles', 'show', 'household', '--json'], home);
    expect((JSON.parse(shownJson.output) as { kind?: unknown }).kind).toBe('agent.profiles.show');

    const deleteRefused = await runProfilesCli(['profiles', 'delete', 'household'], home);
    expect(deleteRefused.result.exitCode).toBe(2);
    expect(deleteRefused.output).toContain('without --yes');

    const deleted = await runProfilesCli(['profiles', 'delete', 'household', '--yes'], home);
    expect(deleted.result.exitCode).toBe(0);
    expect(deleted.output).toContain('Agent profile deleted: household');
  });

  test('returns structured json envelopes', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-json');
    const result = await runProfilesCli(['profiles', 'list', '--json'], home);
    const parsed = JSON.parse(result.output) as { ok?: unknown; kind?: unknown };
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('agent.profiles.list');
  });

  test('sets shows and clears the default Agent profile with confirmation', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-default');
    await runProfilesCli(['profiles', 'create', 'Household', '--template', 'household', '--yes'], home);

    const refused = await runProfilesCli(['profiles', 'use', 'household'], home);
    expect(refused.result.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');
    expect(readAgentRuntimeProfileSelection(home)).toBeNull();

    const selected = await runProfilesCli(['profiles', 'use', 'household', '--yes'], home);
    expect(selected.result.exitCode).toBe(0);
    expect(selected.output).toContain('Default Agent profile: household');
    expect(selected.output).toContain('next launch: goodvibes-agent');
    expect(readAgentRuntimeProfileSelection(home)?.id).toBe('household');

    const shown = await runProfilesCli(['profiles', 'default', '--json'], home);
    const parsed = JSON.parse(shown.output) as {
      readonly ok?: unknown;
      readonly kind?: unknown;
      readonly data?: { readonly selectedProfile?: { readonly id?: unknown } };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.kind).toBe('agent.profiles.default');
    expect(parsed.data?.selectedProfile?.id).toBe('household');

    const clearRefused = await runProfilesCli(['profiles', 'default', 'clear'], home);
    expect(clearRefused.result.exitCode).toBe(2);
    expect(clearRefused.output).toContain('without --yes');

    const cleared = await runProfilesCli(['profiles', 'default', 'clear', '--yes'], home);
    expect(cleared.result.exitCode).toBe(0);
    expect(cleared.output).toContain('Default Agent profile cleared');
    expect(readAgentRuntimeProfileSelection(home)).toBeNull();
  });

  test('lists starter templates and creates a seeded profile', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-starter');
    const templates = await runProfilesCli(['profiles', 'templates'], home);
    expect(templates.result.exitCode).toBe(0);
    expect(templates.output).toContain('household');
    expect(templates.output).toContain('personal-productivity');

    const created = await runProfilesCli(['profiles', 'create', 'research-lab', '--template', 'research', '--yes'], home);
    expect(created.result.exitCode).toBe(0);
    expect(created.output).toContain('starter: research');
    expect(created.output).toContain('seeded: 1 persona, 2 skills, 1 routine');

    const skillRegistry = new AgentSkillRegistry(join(home, '.goodvibes', 'agent', 'profile-homes', 'research-lab', '.goodvibes', 'agent', 'skills', 'skills.json'));
    expect(skillRegistry.snapshot().enabledSkills.map((skill) => skill.name)).toContain('Source-grounded Brief');

    const listed = await runProfilesCli(['profiles', 'list'], home);
    expect(listed.output).toContain('starter=research');

    const shown = await runProfilesCli(['profiles', 'show', 'research-lab'], home);
    expect(shown.output).toContain('starter: research');
  });

  test('rejects unknown starter templates before writing profile records', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-starter-error');
    const result = await runProfilesCli(['profiles', 'create', 'bad', '--template', 'unknown', '--yes'], home);
    expect(result.result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown Agent starter profile template');
  });

  test('exports imports and applies a custom starter template through the CLI', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-custom-starter');
    const path = join(home, 'custom-starter.json');
    mkdirSync(join(home, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', 'agent', 'VIBE.md'), [
      '# CLI VIBE',
      '',
      'Prefer morning briefing answers with a short risk line.',
    ].join('\n'));

    const exportRefused = await runProfilesCli(['profiles', 'templates', 'export', 'research', path], home);
    expect(exportRefused.result.exitCode).toBe(2);
    expect(exportRefused.output).toContain('without --yes');

    const exported = await runProfilesCli(['profiles', 'templates', 'export', 'research', path, '--include-vibe', '--yes'], home);
    expect(exported.result.exitCode).toBe(0);
    expect(exported.output).toContain('Agent starter template exported: research');
    expect(exported.output).toContain('vibe included');

    const raw = JSON.parse(readFileSync(path, 'utf-8')) as {
      template: {
        id: string;
        name: string;
        persona: { name: string };
        skills: Array<{ name: string }>;
        routines: Array<{ name: string }>;
        vibe?: { body?: string };
      };
    };
    expect(raw.template.vibe?.body).toContain('short risk line');
    raw.template.id = 'daily-briefing';
    raw.template.name = 'Daily Briefing';
    raw.template.persona.name = 'Daily Briefing Operator';
    raw.template.skills[0]!.name = 'Morning Source Brief';
    raw.template.routines[0]!.name = 'Morning Review';
    writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

    const importRefused = await runProfilesCli(['profiles', 'templates', 'import', path], home);
    expect(importRefused.result.exitCode).toBe(2);
    expect(importRefused.output).toContain('without --yes');

    const imported = await runProfilesCli(['profiles', 'templates', 'import', path, '--yes'], home);
    expect(imported.result.exitCode).toBe(0);
    expect(imported.output).toContain('Agent starter template imported: daily-briefing');
    expect(imported.output).toContain('vibe included');

    const templates = await runProfilesCli(['profiles', 'templates'], home);
    expect(templates.output).toContain('daily-briefing');
    expect(templates.output).toContain('[local]');
    expect(templates.output).toContain('vibe included');

    const created = await runProfilesCli(['profiles', 'create', 'briefing', '--template', 'daily-briefing', '--yes'], home);
    expect(created.result.exitCode).toBe(0);
    expect(created.output).toContain('starter: daily-briefing');
    expect(created.output).toContain('vibe ');
    expect(readFileSync(join(home, '.goodvibes', 'agent', 'profile-homes', 'briefing', '.goodvibes', 'agent', 'VIBE.md'), 'utf-8')).toContain('short risk line');
  });

  test('creates a starter template from discovered behavior through the CLI', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-discovered');
    mkdirSync(join(home, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(home, '.goodvibes', 'agent', 'skills', 'briefing'), { recursive: true });
    mkdirSync(join(home, '.goodvibes', 'agent', 'routines'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', 'agent', 'personas', 'research.md'), [
      '---',
      'name: Research Operator',
      '---',
      'Prefer checked sources and clear unknowns.',
    ].join('\n'));
    writeFileSync(join(home, '.goodvibes', 'agent', 'skills', 'briefing', 'SKILL.md'), [
      '---',
      'name: Daily Brief Skill',
      '---',
      'Review work plans, approvals, routines, and Agent Knowledge before summarizing.',
    ].join('\n'));
    writeFileSync(join(home, '.goodvibes', 'agent', 'routines', 'evening.md'), [
      '---',
      'name: Evening Review',
      '---',
      'Review work plan, approvals, routines, and Agent Knowledge status.',
    ].join('\n'));

    const refused = await runProfilesCli(['profiles', 'templates', 'from-discovered', 'research-desk'], home);
    expect(refused.result.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const created = await runProfilesCli(['profiles', 'templates', 'from-discovered', 'research-desk', '--name', 'Research Desk', '--yes'], home);
    expect(created.result.exitCode).toBe(0);
    expect(created.output).toContain('Agent starter template created from discovered behavior: research-desk');

    const profile = await runProfilesCli(['profiles', 'create', 'desk', '--template', 'research-desk', '--yes'], home);
    expect(profile.result.exitCode).toBe(0);
    expect(profile.output).toContain('starter: research-desk');

    const personaRegistry = new AgentPersonaRegistry(join(home, '.goodvibes', 'agent', 'profile-homes', 'desk', '.goodvibes', 'agent', 'personas', 'personas.json'));
    expect(personaRegistry.snapshot().activePersona?.name).toBe('Research Operator');
  });

  test('creates a profile directly from discovered behavior through the CLI', async () => {
    const home = makeProjectTempDir('goodvibes-agent-profiles-direct-discovered');
    mkdirSync(join(home, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(home, '.goodvibes', 'agent', 'skills', 'briefing'), { recursive: true });
    mkdirSync(join(home, '.goodvibes', 'agent', 'routines'), { recursive: true });
    writeFileSync(join(home, '.goodvibes', 'agent', 'personas', 'research.md'), [
      '---',
      'name: Research Operator',
      '---',
      'Prefer checked sources and clear unknowns.',
    ].join('\n'));
    writeFileSync(join(home, '.goodvibes', 'agent', 'skills', 'briefing', 'SKILL.md'), [
      '---',
      'name: Daily Brief Skill',
      '---',
      'Review work plans, approvals, routines, and Agent Knowledge before summarizing.',
    ].join('\n'));
    writeFileSync(join(home, '.goodvibes', 'agent', 'routines', 'evening.md'), [
      '---',
      'name: Evening Review',
      '---',
      'Review work plan, approvals, routines, and Agent Knowledge status.',
    ].join('\n'));

    const refused = await runProfilesCli(['profiles', 'create-from-discovered', 'desk'], home);
    expect(refused.result.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const created = await runProfilesCli(['profiles', 'create-from-discovered', 'desk', '--template-id', 'research-desk', '--name', 'Research Desk', '--yes'], home);
    expect(created.result.exitCode).toBe(0);
    expect(created.output).toContain('Agent profile created from discovered behavior: desk');
    expect(created.output).toContain('starter: research-desk');
    expect(created.output).toContain('launch: goodvibes-agent --agent-profile desk');

    const personaRegistry = new AgentPersonaRegistry(join(home, '.goodvibes', 'agent', 'profile-homes', 'desk', '.goodvibes', 'agent', 'personas', 'personas.json'));
    expect(personaRegistry.snapshot().activePersona?.name).toBe('Research Operator');
  });
});
