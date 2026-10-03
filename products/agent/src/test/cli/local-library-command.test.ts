import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp } from '../../cli/help.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

async function runCli(args: readonly string[], homeDirectory?: string): Promise<{
  readonly exitCode: number;
  readonly output: string;
}> {
  const root = homeDirectory ?? makeProjectTempDir('goodvibes-agent-local-library-cli');
  if (!homeDirectory) roots.push(root);
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'agent' }),
      workingDirectory: root,
      homeDirectory: root,
    });
    return {
      exitCode: result.exitCode,
      output: output.join('\n'),
    };
  } finally {
    console.log = originalLog;
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local Agent library CLI commands', () => {
  test('parses personas and skills commands plus aliases', () => {
    expect(parseGoodVibesCli(['personas', 'list']).command).toBe('personas');
    expect(parseGoodVibesCli(['persona', 'list']).command).toBe('personas');
    expect(parseGoodVibesCli(['skills', 'list']).command).toBe('skills');
    expect(parseGoodVibesCli(['agent-skills', 'list']).command).toBe('skills');
  });

  test('creates lists activates reviews and deletes local personas', async () => {
    const home = makeProjectTempDir('goodvibes-agent-personas-cli');
    roots.push(home);

    const created = await runCli([
      'personas',
      'create',
      '--name',
      'Travel Planner',
      '--description',
      'Plan trips',
      '--body',
      'Compare options before booking.',
      '--tags',
      'travel,planning',
      '--use',
    ], home);
    expect(created.exitCode).toBe(0);
    expect(created.output).toContain('travel-planner');
    expect(created.output).toContain('(active)');

    const active = await runCli(['personas', 'active'], home);
    expect(active.output).toContain('Travel Planner');
    expect(active.output).toContain('active: yes');

    const searched = await runCli(['personas', 'search', 'booking'], home);
    expect(searched.output).toContain('Travel Planner');

    const reviewed = await runCli(['personas', 'review', 'travel-planner', '--json'], home);
    const reviewedJson = JSON.parse(reviewed.output) as { readonly kind?: unknown; readonly data?: { readonly reviewState?: unknown } };
    expect(reviewedJson.kind).toBe('agent.personas.review');
    expect(reviewedJson.data?.reviewState).toBe('reviewed');

    const refused = await runCli(['personas', 'delete', 'travel-planner'], home);
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const deleted = await runCli(['personas', 'delete', 'travel-planner', '--yes'], home);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.output).toContain('Agent persona deleted: travel-planner');
  });

  test('rejects secret-looking persona content', async () => {
    const result = await runCli([
      'personas',
      'create',
      '--name',
      'Bad',
      '--description',
      'Contains secret',
      '--body',
      'api_key=supersecretvalue',
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('cannot store secret-looking values');
  });

  test('preserves option-looking persona and skill values from the CLI', async () => {
    const home = makeProjectTempDir('goodvibes-agent-local-library-flag-values');
    roots.push(home);

    const persona = await runCli([
      'personas',
      'create',
      '--name=Flag Persona',
      '--description',
      '--prefer-explicit-approval',
      '--body',
      '--ask before sending, scheduling, or changing services.',
      '--tags=ops,flags',
    ], home);
    expect(persona.exitCode).toBe(0);

    const skill = await runCli([
      'skills',
      'create',
      '--name=Flag Skill',
      '--description',
      'Capture command-line procedure text.',
      '--procedure',
      '--dry-run first, then ask before external writes.',
      '--tags=cli,flags',
    ], home);
    expect(skill.exitCode).toBe(0);

    const shownPersona = await runCli(['personas', 'show', 'flag-persona'], home);
    const shownSkill = await runCli(['skills', 'show', 'flag-skill'], home);

    expect(shownPersona.output).toContain('--prefer-explicit-approval');
    expect(shownPersona.output).toContain('--ask before sending, scheduling, or changing services.');
    expect(shownPersona.output).toContain('tags: ops, flags');
    expect(shownSkill.output).toContain('--dry-run first, then ask before external writes.');
    expect(shownSkill.output).toContain('tags: cli, flags');
  });

  test('discovers previews and imports persona files from the CLI', async () => {
    const home = makeProjectTempDir('goodvibes-agent-personas-discovery-cli');
    roots.push(home);
    const personaDir = join(home, '.goodvibes', 'agent', 'personas', 'travel-planner');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'PERSONA.md'), [
      '---',
      'name: Travel Planner',
      'description: Compare routes, lodging, and constraints before booking',
      'tags: travel,planning',
      'triggers: trip,vacation',
      '---',
      'Ask for dates, budget, destination constraints, and traveler preferences.',
      'Do not book without explicit confirmation.',
      '',
    ].join('\n'));
    const copiedAgentDir = join(home, '.goodvibes', 'agents', 'reviewer');
    mkdirSync(copiedAgentDir, { recursive: true });
    writeFileSync(join(copiedAgentDir, 'AGENT.md'), [
      '---',
      'name: Coding Reviewer',
      'description: Copied coding agent file that must not become an Agent persona',
      '---',
      'Review code and spawn fix work.',
      '',
    ].join('\n'));
    const legacyMarkerDir = join(home, '.goodvibes', 'agent', 'personas', 'legacy-coding-agent');
    mkdirSync(legacyMarkerDir, { recursive: true });
    writeFileSync(join(legacyMarkerDir, 'AGENT.md'), [
      '---',
      'name: Legacy Coding Agent',
      'description: Legacy marker that must not be treated as an Agent persona',
      '---',
      'Act like a coding agent.',
      '',
    ].join('\n'));

    const discovered = await runCli(['personas', 'discover'], home);
    expect(discovered.exitCode).toBe(0);
    expect(discovered.output).toContain('Discovered Agent persona files (1)');
    expect(discovered.output).toContain('Travel Planner');
    expect(discovered.output).toContain('travel-planner/PERSONA.md');
    expect(discovered.output).not.toContain('Coding Reviewer');
    expect(discovered.output).not.toContain('Legacy Coding Agent');

    const discoveredJson = await runCli(['personas', 'discover', '--json'], home);
    const discoveredPayload = JSON.parse(discoveredJson.output) as {
      readonly kind?: unknown;
      readonly data?: { readonly personas?: readonly { readonly name?: unknown; readonly origin?: unknown }[] };
    };
    expect(discoveredPayload.kind).toBe('agent.personas.discover');
    expect(discoveredPayload.data?.personas?.[0]?.name).toBe('Travel Planner');
    expect(discoveredPayload.data?.personas?.[0]?.origin).toBe('project-local');
    expect(discoveredPayload.data?.personas?.map((persona) => persona.name)).not.toContain('Coding Reviewer');
    expect(discoveredPayload.data?.personas?.map((persona) => persona.name)).not.toContain('Legacy Coding Agent');

    const preview = await runCli(['personas', 'import-discovered', 'travel-planner'], home);
    expect(preview.exitCode).toBe(0);
    expect(preview.output).toContain('Agent persona import preview');
    expect(preview.output).toContain('rerun with --yes');

    const beforeImport = await runCli(['personas', 'list'], home);
    expect(beforeImport.output).toContain('No local Agent personas yet.');

    const imported = await runCli(['personas', 'import-discovered', 'Travel', 'Planner', '--use', '--yes'], home);
    expect(imported.exitCode).toBe(0);
    expect(imported.output).toContain('Imported Agent persona travel-planner: Travel Planner (active)');

    const active = await runCli(['personas', 'active'], home);
    expect(active.output).toContain('Travel Planner');
    expect(active.output).toContain('active: yes');

    const shownJson = await runCli(['personas', 'show', 'travel-planner', '--json'], home);
    const shownPayload = JSON.parse(shownJson.output) as {
      readonly kind?: unknown;
      readonly data?: { readonly source?: unknown; readonly provenance?: unknown; readonly tags?: readonly string[]; readonly triggers?: readonly string[] };
    };
    expect(shownPayload.kind).toBe('agent.personas.show');
    expect(shownPayload.data?.source).toBe('imported');
    expect(String(shownPayload.data?.provenance ?? '')).toContain('discovered:project-local:');
    expect(shownPayload.data?.tags).toContain('travel');
    expect(shownPayload.data?.triggers).toContain('vacation');
  });

  test('empty persona discovery advertises only Agent persona roots', async () => {
    const home = makeProjectTempDir('goodvibes-agent-empty-personas-cli');
    roots.push(home);

    const discovered = await runCli(['personas', 'discover'], home);
    expect(discovered.exitCode).toBe(0);
    expect(discovered.output).toContain('No persona markdown files found in Agent persona folders.');
    expect(discovered.output).toContain('.goodvibes/personas, .goodvibes/agent/personas');
    expect(discovered.output).not.toContain('.goodvibes/agents');
    expect(discovered.output).not.toContain('~/.goodvibes/agents');
  });

  test('creates enables bundles reviews and deletes local skills', async () => {
    const home = makeProjectTempDir('goodvibes-agent-skills-cli');
    roots.push(home);

    const created = await runCli([
      'skills',
      'create',
      '--name',
      'Daily Brief',
      '--description',
      'Summarize operator state',
      '--procedure',
      'Review Agent Knowledge, work plans, approvals, and routines.',
      '--triggers',
      'morning,daily',
      '--requires-env',
      'GOODVIBES_AGENT_TEST_MISSING_TOKEN',
      '--requires-command',
      'definitely-missing-goodvibes-agent-test-bin',
      '--enabled',
    ], home);
    expect(created.exitCode).toBe(0);
    expect(created.output).toContain('daily-brief');
    expect(created.output).toContain('(enabled)');

    const active = await runCli(['skills', 'active'], home);
    expect(active.output).toContain('Daily Brief');
    expect(active.output).toContain('needs env:GOODVIBES_AGENT_TEST_MISSING_TOKEN,command:definitely-missing-goodvibes-agent-test-bin');

    const attention = await runCli(['skills', 'attention'], home);
    expect(attention.exitCode).toBe(0);
    expect(attention.output).toContain('Agent skills needing setup');
    expect(attention.output).toContain('Daily Brief');

    const shown = await runCli(['skills', 'show', 'daily-brief', '--json'], home);
    const shownParsed = JSON.parse(shown.output) as {
      readonly kind?: unknown;
      readonly data?: { readonly requirements?: readonly { readonly kind?: unknown; readonly name?: unknown }[] };
    };
    expect(shownParsed.kind).toBe('agent.skills.show');
    expect(shownParsed.data?.requirements?.map((requirement) => `${String(requirement.kind)}:${String(requirement.name)}`)).toEqual([
      'env:GOODVIBES_AGENT_TEST_MISSING_TOKEN',
      'command:definitely-missing-goodvibes-agent-test-bin',
    ]);

    const bundle = await runCli([
      'skills',
      'bundle',
      'create',
      '--name',
      'Ops Pack',
      '--description',
      'Daily operations bundle',
      '--skills',
      'daily-brief',
      '--enabled',
    ], home);
    expect(bundle.exitCode).toBe(0);
    expect(bundle.output).toContain('ops-pack');

    const bundleJson = await runCli(['skills', 'bundle', 'show', 'ops-pack', '--json'], home);
    const parsed = JSON.parse(bundleJson.output) as { readonly kind?: unknown; readonly data?: { readonly skillIds?: readonly string[] } };
    expect(parsed.kind).toBe('agent.skills.bundles.show');
    expect(parsed.data?.skillIds).toContain('daily-brief');

    const bundleShown = await runCli(['skills', 'bundle', 'show', 'ops-pack'], home);
    expect(bundleShown.output).toContain('readiness: needs setup');
    expect(bundleShown.output).toContain('missing: env:GOODVIBES_AGENT_TEST_MISSING_TOKEN, command:definitely-missing-goodvibes-agent-test-bin');

    const bundleAttention = await runCli(['skills', 'bundle', 'attention'], home);
    expect(bundleAttention.exitCode).toBe(0);
    expect(bundleAttention.output).toContain('Agent skill bundles needing setup');
    expect(bundleAttention.output).toContain('ops-pack');
    expect(bundleAttention.output).toContain('needs env:GOODVIBES_AGENT_TEST_MISSING_TOKEN,command:definitely-missing-goodvibes-agent-test-bin');

    const stale = await runCli(['skills', 'stale', 'daily-brief', 'Needs update'], home);
    expect(stale.exitCode).toBe(0);
    expect(stale.output).toContain('daily-brief');

    const refused = await runCli(['skills', 'delete', 'daily-brief'], home);
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const deleted = await runCli(['skills', 'delete', 'daily-brief', '--yes'], home);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.output).toContain('Agent skill deleted: daily-brief');
  });

  test('discovers previews and imports skill files from the CLI', async () => {
    const home = makeProjectTempDir('goodvibes-agent-skills-discovery-cli');
    roots.push(home);
    const skillDir = join(home, '.goodvibes', 'agent', 'skills', 'travel-planner');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      'name: Travel Planner',
      'description: Compare routes, lodging, and constraints before booking',
      'tags: travel,planning',
      'triggers: trip,vacation',
      '---',
      'Ask for dates, budget, destination constraints, and traveler preferences.',
      'Compare options before recommending a booking path.',
      '',
    ].join('\n'));

    const discovered = await runCli(['skills', 'discover'], home);
    expect(discovered.exitCode).toBe(0);
    expect(discovered.output).toContain('Discovered Agent skill files (1)');
    expect(discovered.output).toContain('Travel Planner');
    expect(discovered.output).toContain('travel-planner/SKILL.md');

    const discoveredJson = await runCli(['skills', 'discover', '--json'], home);
    const discoveredPayload = JSON.parse(discoveredJson.output) as {
      readonly kind?: unknown;
      readonly data?: { readonly skills?: readonly { readonly name?: unknown; readonly origin?: unknown }[] };
    };
    expect(discoveredPayload.kind).toBe('agent.skills.discover');
    expect(discoveredPayload.data?.skills?.[0]?.name).toBe('Travel Planner');
    expect(discoveredPayload.data?.skills?.[0]?.origin).toBe('project-local');

    const preview = await runCli(['skills', 'import-discovered', 'travel-planner'], home);
    expect(preview.exitCode).toBe(0);
    expect(preview.output).toContain('Agent skill import preview');
    expect(preview.output).toContain('rerun with --yes');

    const beforeImport = await runCli(['skills', 'list'], home);
    expect(beforeImport.output).toContain('No local Agent skills yet.');

    const imported = await runCli(['skills', 'import-discovered', 'Travel', 'Planner', '--enabled', '--yes'], home);
    expect(imported.exitCode).toBe(0);
    expect(imported.output).toContain('Imported Agent skill travel-planner: Travel Planner (enabled)');

    const active = await runCli(['skills', 'active'], home);
    expect(active.output).toContain('Travel Planner');
    expect(active.output).toContain('enabled');

    const shownJson = await runCli(['skills', 'show', 'travel-planner', '--json'], home);
    const shownPayload = JSON.parse(shownJson.output) as {
      readonly kind?: unknown;
      readonly data?: { readonly source?: unknown; readonly provenance?: unknown; readonly tags?: readonly string[]; readonly triggers?: readonly string[] };
    };
    expect(shownPayload.kind).toBe('agent.skills.show');
    expect(shownPayload.data?.source).toBe('imported');
    expect(String(shownPayload.data?.provenance ?? '')).toContain('discovered:project-local:');
    expect(shownPayload.data?.tags).toContain('travel');
    expect(shownPayload.data?.triggers).toContain('vacation');
  });

  test('top-level help advertises local personas and skills', async () => {
    const help = renderGoodVibesHelp();
    expect(help).toContain('personas');
    expect(help).toContain('skills');
    expect(help).toContain('Manage local Agent personas');
    expect(help).toContain('Manage local Agent skills');

    const personaHelp = renderGoodVibesCommandHelp('personas');
    expect(personaHelp).toContain('GoodVibes Agent personas');
    expect(personaHelp).toContain('Personas do not create separate Agent jobs');
    expect(personaHelp).not.toContain('worker agents');
    expect(personaHelp).toContain('personas discover');
    expect(personaHelp).toContain('personas import-discovered');
    expect(personaHelp).toContain('personas create');

    const skillsHelp = renderGoodVibesCommandHelp('skills');
    expect(skillsHelp).toContain('GoodVibes Agent skills');
    expect(skillsHelp).toContain('skills discover');
    expect(skillsHelp).toContain('skills import-discovered');
    expect(skillsHelp).toContain('skills bundle attention');
    expect(skillsHelp).toContain('skills bundle create');
  });
});
