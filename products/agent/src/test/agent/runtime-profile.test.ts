import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assertValidAgentRuntimeProfileId,
  clearAgentRuntimeProfileSelection,
  createAgentRuntimeProfile,
  createAgentRuntimeProfileFromDiscovered,
  deleteAgentRuntimeProfile,
  exportAgentRuntimeProfileTemplate,
  getAgentRuntimeProfilesRoot,
  importAgentRuntimeProfileTemplate,
  createAgentRuntimeProfileTemplateFromDiscovered,
  listAgentRuntimeProfileTemplates,
  listAgentRuntimeProfiles,
  normalizeAgentRuntimeProfileId,
  readAgentRuntimeProfileSelection,
  resolveAgentRuntimeProfileHome,
  resolveSelectedAgentRuntimeProfileHome,
  setAgentRuntimeProfileSelection,
} from '../../agent/runtime-profile.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentRoutineRegistry } from '../../agent/routine-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function makeHome(): string {
  return makeProjectTempDir('goodvibes-agent-profile-home');
}

describe('Agent profiles', () => {
  test('normalizes profile names into stable launch ids', () => {
    expect(normalizeAgentRuntimeProfileId('Household Ops')).toBe('household-ops');
    expect(normalizeAgentRuntimeProfileId('  ops.prod  ')).toBe('ops.prod');
  });

  test('rejects path traversal and empty profile names', () => {
    expect(() => assertValidAgentRuntimeProfileId('../default')).toThrow('path traversal');
    expect(() => assertValidAgentRuntimeProfileId('!!!')).toThrow('Agent profile names');
  });

  test('resolves isolated profile home below the Agent profile root', () => {
    const home = makeHome();
    const resolved = resolveAgentRuntimeProfileHome(home, 'Household Ops');
    expect(resolved.id).toBe('household-ops');
    expect(resolved.homeDirectory).toBe(join(getAgentRuntimeProfilesRoot(home), 'household-ops'));
  });

  test('creates, lists, and deletes isolated profile homes', () => {
    const home = makeHome();
    const created = createAgentRuntimeProfile(home, 'Household');
    expect(created.id).toBe('household');
    expect(existsSync(created.homeDirectory)).toBe(true);

    const profiles = listAgentRuntimeProfiles(home);
    expect(profiles.map((profile) => profile.id)).toEqual(['household']);
    expect(typeof profiles[0]?.createdAt).toBe('string');

    expect(deleteAgentRuntimeProfile(home, 'household')).toBe(true);
    expect(deleteAgentRuntimeProfile(home, 'household')).toBe(false);
    expect(listAgentRuntimeProfiles(home)).toEqual([]);
  });

  test('selects and clears a default profile for future plain launches', () => {
    const home = makeHome();
    const created = createAgentRuntimeProfile(home, 'Research Desk', { templateId: 'research' });

    const selected = setAgentRuntimeProfileSelection(home, 'research-desk');
    expect(selected.id).toBe('research-desk');
    expect(selected.homeDirectory).toBe(created.homeDirectory);
    expect(selected.exists).toBe(true);
    expect(readAgentRuntimeProfileSelection(home)?.id).toBe('research-desk');
    expect(resolveSelectedAgentRuntimeProfileHome(home)?.homeDirectory).toBe(created.homeDirectory);

    expect(clearAgentRuntimeProfileSelection(home)).toBe(true);
    expect(clearAgentRuntimeProfileSelection(home)).toBe(false);
    expect(readAgentRuntimeProfileSelection(home)).toBeNull();
    expect(resolveSelectedAgentRuntimeProfileHome(home)).toBeNull();
  });

  test('deleting the selected profile clears the default profile selection', () => {
    const home = makeHome();
    createAgentRuntimeProfile(home, 'Ops', { templateId: 'operations' });
    setAgentRuntimeProfileSelection(home, 'ops');

    expect(deleteAgentRuntimeProfile(home, 'ops')).toBe(true);
    expect(readAgentRuntimeProfileSelection(home)).toBeNull();
    expect(resolveSelectedAgentRuntimeProfileHome(home)).toBeNull();
  });

  test('lists curated starter profile templates', () => {
    const ids = listAgentRuntimeProfileTemplates().map((template) => template.id);
    expect(ids).toEqual(['household', 'research', 'travel', 'operations', 'personal-productivity']);
  });

  test('creates a profile from a starter template with local persona skills and routine', () => {
    const home = makeHome();
    const created = createAgentRuntimeProfile(home, 'Ops', { templateId: 'operations' });
    expect(created.id).toBe('ops');
    expect(created.starterTemplateId).toBe('operations');
    expect(created.starterTemplateApplication?.personaIds).toEqual(['operations-lead']);
    expect(created.starterTemplateApplication?.skillIds).toContain('incident-intake');
    expect(created.starterTemplateApplication?.routineIds).toEqual(['daily-operations-sweep']);

    const persona = new AgentPersonaRegistry(join(created.homeDirectory, '.goodvibes', 'agent', 'personas', 'personas.json')).snapshot();
    const skills = new AgentSkillRegistry(join(created.homeDirectory, '.goodvibes', 'agent', 'skills', 'skills.json')).snapshot();
    const routines = new AgentRoutineRegistry(join(created.homeDirectory, '.goodvibes', 'agent', 'routines', 'routines.json')).snapshot();
    expect(persona.activePersona?.name).toBe('Operations Lead');
    expect(skills.enabledSkills.map((skill) => skill.name)).toContain('Incident Intake');
    expect(routines.enabledRoutines.map((routine) => routine.name)).toContain('Daily Operations Sweep');

    const listed = listAgentRuntimeProfiles(home);
    expect(listed[0]?.starterTemplateId).toBe('operations');
  });

  test('exports edits imports and uses a local starter template', () => {
    const home = makeHome();
    const exportedPath = join(home, 'research-starter.json');
    const exported = exportAgentRuntimeProfileTemplate(home, 'research', exportedPath);
    expect(exported.path).toBe(exportedPath);

    const raw = JSON.parse(readFileSync(exportedPath, 'utf-8')) as {
      template: {
        id: string;
        name: string;
        persona: { name: string };
        skills: Array<{ name: string }>;
        routines: Array<{ name: string }>;
      };
    };
    raw.template.id = 'lab-operator';
    raw.template.name = 'Lab Operator';
    raw.template.persona.name = 'Lab Operator';
    raw.template.skills[0]!.name = 'Lab Source Brief';
    raw.template.routines[0]!.name = 'Lab Review';
    writeFileSync(exportedPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

    const imported = importAgentRuntimeProfileTemplate(home, exportedPath);
    expect(imported.id).toBe('lab-operator');
    expect(imported.source).toBe('local');
    expect(listAgentRuntimeProfileTemplates(home).map((template) => template.id)).toContain('lab-operator');

    const profile = createAgentRuntimeProfile(home, 'lab', { templateId: 'lab-operator' });
    const persona = new AgentPersonaRegistry(join(profile.homeDirectory, '.goodvibes', 'agent', 'personas', 'personas.json')).snapshot();
    expect(persona.activePersona?.name).toBe('Lab Operator');
  });

  test('exports imports and applies starter templates with VIBE.md when requested', () => {
    const home = makeHome();
    const workspace = makeProjectTempDir('goodvibes-agent-profile-vibe-workspace');
    mkdirSync(join(workspace, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'VIBE.md'), [
      '# Project VIBE',
      '',
      'Prefer concise profile-specific operator replies.',
    ].join('\n'));

    const exportedPath = join(home, 'research-with-vibe.json');
    const exported = exportAgentRuntimeProfileTemplate(home, 'research', exportedPath, {
      includeVibe: true,
      shellPaths: {
        homeDirectory: home,
        workingDirectory: workspace,
      },
    });
    expect(exported.vibeIncluded).toBe(true);
    const raw = JSON.parse(readFileSync(exportedPath, 'utf-8')) as {
      template: {
        id: string;
        name: string;
        vibe?: { body?: string; sourcePaths?: readonly string[] };
      };
    };
    expect(raw.template.vibe?.body).toContain('Prefer concise profile-specific operator replies.');
    expect(raw.template.vibe?.sourcePaths?.join('\n')).toContain('VIBE.md');
    raw.template.id = 'research-with-vibe';
    raw.template.name = 'Research With Vibe';
    writeFileSync(exportedPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');

    const imported = importAgentRuntimeProfileTemplate(home, exportedPath);
    expect(imported.vibeIncluded).toBe(true);
    const profile = createAgentRuntimeProfile(home, 'research-vibe', { templateId: 'research-with-vibe' });
    expect(profile.starterTemplateApplication?.vibePath).toBe(join(profile.homeDirectory, '.goodvibes', 'agent', 'VIBE.md'));
    expect(readFileSync(profile.starterTemplateApplication!.vibePath!, 'utf-8')).toContain('Prefer concise profile-specific operator replies.');
  });

  test('creates a local starter template from discovered Agent behavior files', async () => {
    const home = makeHome();
    const workspace = makeProjectTempDir('goodvibes-agent-profile-discovery-workspace');
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'skills', 'daily-brief'), { recursive: true });
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'routines'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'personas', 'research.md'), [
      '---',
      'name: Research Operator',
      'description: Source-backed research posture.',
      'tags: research,operator',
      '---',
      'Prefer checked sources and clear unknowns.',
    ].join('\n'));
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'skills', 'daily-brief', 'SKILL.md'), [
      '---',
      'name: Daily Brief Skill',
      'description: Build a concise operator brief.',
      'triggers: brief, morning',
      '---',
      'Review work plans, approvals, routines, and Agent Knowledge before summarizing.',
    ].join('\n'));
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'routines', 'evening.md'), [
      '---',
      'name: Evening Review',
      'description: Review open work before shutdown.',
      '---',
      'Review work plan, approvals, routines, and Agent Knowledge status.',
    ].join('\n'));
    writeFileSync(join(workspace, 'VIBE.md'), [
      '# Research Desk VIBE',
      '',
      'Keep research profile answers source-first and compact.',
    ].join('\n'));

    const starter = await createAgentRuntimeProfileTemplateFromDiscovered({
      homeDirectory: home,
      workingDirectory: workspace,
    }, {
      id: 'research-desk',
      name: 'Research Desk',
      includeVibe: true,
    });

    expect(starter.id).toBe('research-desk');
    expect(starter.personaName).toBe('Research Operator');
    expect(starter.skillNames).toEqual(['Daily Brief Skill']);
    expect(starter.routineNames).toEqual(['Evening Review']);
    expect(starter.vibeIncluded).toBe(true);
    expect(listAgentRuntimeProfileTemplates(home).map((template) => template.id)).toContain('research-desk');

    const profile = createAgentRuntimeProfile(home, 'desk', { templateId: 'research-desk' });
    const persona = new AgentPersonaRegistry(join(profile.homeDirectory, '.goodvibes', 'agent', 'personas', 'personas.json')).snapshot();
    const skills = new AgentSkillRegistry(join(profile.homeDirectory, '.goodvibes', 'agent', 'skills', 'skills.json')).snapshot();
    const routines = new AgentRoutineRegistry(join(profile.homeDirectory, '.goodvibes', 'agent', 'routines', 'routines.json')).snapshot();
    expect(persona.activePersona?.name).toBe('Research Operator');
    expect(skills.enabledSkills.map((skill) => skill.name)).toEqual(['Daily Brief Skill']);
    expect(routines.enabledRoutines.map((routine) => routine.name)).toEqual(['Evening Review']);
    expect(readFileSync(join(profile.homeDirectory, '.goodvibes', 'agent', 'VIBE.md'), 'utf-8')).toContain('source-first');
  });

  test('creates a profile directly from discovered Agent behavior files', async () => {
    const home = makeHome();
    const workspace = makeProjectTempDir('goodvibes-agent-profile-direct-discovery');
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'skills', 'briefing'), { recursive: true });
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'routines'), { recursive: true });
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'personas', 'research.md'), [
      '---',
      'name: Research Operator',
      '---',
      'Prefer checked sources and clear unknowns.',
    ].join('\n'));
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'skills', 'briefing', 'SKILL.md'), [
      '---',
      'name: Daily Brief Skill',
      '---',
      'Review work plans, approvals, routines, and Agent Knowledge before summarizing.',
    ].join('\n'));
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'routines', 'evening.md'), [
      '---',
      'name: Evening Review',
      '---',
      'Review work plan, approvals, routines, and Agent Knowledge status.',
    ].join('\n'));

    const created = await createAgentRuntimeProfileFromDiscovered({
      homeDirectory: home,
      workingDirectory: workspace,
    }, {
      profileName: 'desk',
      templateId: 'research-desk',
      name: 'Research Desk',
    });

    expect(created.template.id).toBe('research-desk');
    expect(created.profile.id).toBe('desk');
    expect(created.profile.starterTemplateId).toBe('research-desk');
    const persona = new AgentPersonaRegistry(join(created.profile.homeDirectory, '.goodvibes', 'agent', 'personas', 'personas.json')).snapshot();
    const skills = new AgentSkillRegistry(join(created.profile.homeDirectory, '.goodvibes', 'agent', 'skills', 'skills.json')).snapshot();
    const routines = new AgentRoutineRegistry(join(created.profile.homeDirectory, '.goodvibes', 'agent', 'routines', 'routines.json')).snapshot();
    expect(persona.activePersona?.name).toBe('Research Operator');
    expect(skills.enabledSkills.map((skill) => skill.name)).toEqual(['Daily Brief Skill']);
    expect(routines.enabledRoutines.map((routine) => routine.name)).toEqual(['Evening Review']);
  });

  test('template build refuses discovered content containing secret-looking values', async () => {
    const home = makeHome();
    const workspace = makeProjectTempDir('goodvibes-agent-profile-secret');
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'personas'), { recursive: true });
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'skills'), { recursive: true });
    mkdirSync(join(workspace, '.goodvibes', 'agent', 'routines'), { recursive: true });
    // persona body contains a secret-looking value
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'personas', 'leaked.md'), [
      '---',
      'name: Leaked Persona',
      '---',
      'Use api_key=sk-supersecretvalue123456 to access the service.',
    ].join('\n'));
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'skills', 'SKILL.md'), [
      '---',
      'name: Clean Skill',
      '---',
      'Review work plans before summarizing.',
    ].join('\n'));
    writeFileSync(join(workspace, '.goodvibes', 'agent', 'routines', 'routine.md'), [
      '---',
      'name: Clean Routine',
      '---',
      'Review and summarize progress.',
    ].join('\n'));

    await expect(createAgentRuntimeProfileTemplateFromDiscovered(
      { homeDirectory: home, workingDirectory: workspace },
      { id: 'leaked-template' },
    )).rejects.toThrow("secret-looking");
  });
});
