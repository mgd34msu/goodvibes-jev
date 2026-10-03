import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentSkillRegistry, buildEnabledSkillsPrompt, evaluateAgentSkillReadiness, formatAgentSkillRequirement } from '../../agent/skill-registry.ts';
import { renderSkillStandardMarkdown } from '../../agent/skill-standard.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempRegistry(): { readonly registry: AgentSkillRegistry; readonly paths: ReturnType<typeof createShellPathService> } {
  const root = makeProjectTempDir('goodvibes-agent-skills');
  const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  return { registry: AgentSkillRegistry.fromShellPaths(paths), paths };
}

describe('AgentSkillRegistry', () => {
  test('creates, enables, reviews, marks stale, and deletes local skills', () => {
    const { registry } = tempRegistry();
    const skill = registry.create({
      name: 'Morning Brief',
      description: 'Prepare a concise daily briefing.',
      procedure: 'Check calendar, tasks, weather, and unresolved approvals before summarizing.',
      tags: ['daily', 'briefing', 'daily'],
      triggers: ['morning'],
    });

    expect(skill.id).toBe('morning-brief');
    expect(skill.tags).toEqual(['daily', 'briefing']);
    expect(registry.snapshot().enabledSkills).toHaveLength(0);

    expect(registry.setEnabled('morning-brief', true).enabled).toBe(true);
    expect(registry.snapshot().enabledSkills).toHaveLength(1);
    expect(registry.markReviewed('Morning Brief').reviewState).toBe('reviewed');
    expect(registry.markStale('morning-brief', 'Needs a new approval section.').staleReason).toContain('approval');
    expect(registry.deleteSkill('morning-brief').id).toBe('morning-brief');
    expect(registry.list()).toHaveLength(0);
  });

  test('rejects duplicates and secret-looking procedure content', () => {
    const { registry } = tempRegistry();
    registry.create({
      name: 'Status Review',
      description: 'Review visible connected-host status.',
      procedure: 'Inspect status and report concise warnings.',
    });

    expect(() => registry.create({
      name: 'status review',
      description: 'Duplicate.',
      procedure: 'Duplicate.',
    })).toThrow('Skill already exists');

    expect(() => registry.create({
      name: 'Secret Skill',
      description: 'Invalid.',
      procedure: 'password=hunter2-value',
    })).toThrow('secret-looking');
  });

  test('builds reviewed setup-ready enabled skill prompt without default or non-Agent knowledge coupling', () => {
    const { registry, paths } = tempRegistry();
    registry.create({
      name: 'Approval Review',
      description: 'Summarize pending approvals.',
      procedure: 'Use read-only approval routes first and ask before approve or deny.',
      triggers: ['approval', 'pending request'],
      enabled: true,
    });
    registry.markReviewed('approval-review');

    const prompt = buildEnabledSkillsPrompt(paths);

    expect(prompt).toContain('Enabled GoodVibes Agent Skills');
    expect(prompt).toContain('Approval Review');
    expect(prompt).toContain('Use only reviewed, setup-ready');
    expect(prompt).not.toContain('Suppressed Skills');
    expect(prompt).toContain('same serial assistant conversation');
    expect(prompt).not.toContain('/api/knowledge');
    expect(prompt).not.toContain('non-Agent knowledge fallback');
  });

  test('suppresses unreviewed enabled skills from application prompt', () => {
    const { registry, paths } = tempRegistry();
    registry.create({
      name: 'Unreviewed Skill',
      description: 'Should not steer behavior yet.',
      procedure: 'This procedure must not be applied before review.',
      triggers: ['unsafe'],
      enabled: true,
    });

    const prompt = buildEnabledSkillsPrompt(paths);

    expect(prompt).toContain('Suppressed Skills Pending Review Or Setup');
    expect(prompt).toContain('Unreviewed Skill: review=Needs review');
    expect(prompt).toContain('Do not apply these skills');
    expect(prompt).not.toContain('This procedure must not be applied before review.');
  });

  test('stores setup requirements and reports readiness without secret values', () => {
    const { registry, paths } = tempRegistry();
    const skill = registry.create({
      name: 'Issue Brief',
      description: 'Summarize issues through an installed CLI.',
      procedure: 'Use the CLI and token-backed API to gather issue state.',
      requirements: [
        { kind: 'env', name: 'GOODVIBES_AGENT_TEST_MISSING_TOKEN' },
        { kind: 'command', name: 'definitely-missing-goodvibes-agent-test-bin' },
      ],
      enabled: true,
    });

    expect(skill.requirements.map(formatAgentSkillRequirement)).toEqual([
      'env:GOODVIBES_AGENT_TEST_MISSING_TOKEN',
      'command:definitely-missing-goodvibes-agent-test-bin',
    ]);

    const readiness = evaluateAgentSkillReadiness(skill, {
      env: { GOODVIBES_AGENT_TEST_MISSING_TOKEN: 'redacted', PATH: '' },
      pathValue: '',
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.met.map(formatAgentSkillRequirement)).toEqual(['env:GOODVIBES_AGENT_TEST_MISSING_TOKEN']);
    expect(readiness.missing.map(formatAgentSkillRequirement)).toEqual(['command:definitely-missing-goodvibes-agent-test-bin']);

    const prompt = buildEnabledSkillsPrompt(paths);
    expect(prompt).toContain('command:definitely-missing-goodvibes-agent-test-bin');
    expect(prompt).toContain('Suppressed Skills Pending Review Or Setup');
    expect(prompt).not.toContain('redacted');
  });

  test('creates enabled skill bundles that activate member skills together', () => {
    const { registry, paths } = tempRegistry();
    registry.create({
      name: 'Briefing',
      description: 'Summarize current state.',
      procedure: 'Review visible status and present concise next actions.',
    });
    registry.create({
      name: 'Approval Review',
      description: 'Explain pending approvals.',
      procedure: 'List approval risk, tool, route, and requested decision.',
    });

    const bundle = registry.createBundle({
      name: 'Daily Operator Pack',
      description: 'Use briefing and approval-review procedures together.',
      skillIds: ['briefing', 'approval-review'],
      enabled: true,
    });
    registry.markReviewed('briefing');
    registry.markReviewed('approval-review');
    registry.markBundleReviewed(bundle.id);

    const snapshot = registry.snapshot();
    expect(bundle.id).toBe('daily-operator-pack');
    expect(snapshot.enabledSkills).toHaveLength(0);
    expect(snapshot.enabledBundles.map((entry) => entry.id)).toEqual(['daily-operator-pack']);
    expect(snapshot.activeSkills.map((entry) => entry.id)).toEqual(['briefing', 'approval-review']);

    const prompt = buildEnabledSkillsPrompt(paths);
    expect(prompt).toContain('Skill Bundle: Daily Operator Pack');
    expect(prompt).toContain('Included skills: briefing, approval-review');
    expect(prompt).toContain('Briefing');
    expect(prompt).toContain('Approval Review');
  });

  test('suppresses reviewed member skills when only an unreviewed bundle activates them', () => {
    const { registry, paths } = tempRegistry();
    registry.create({
      name: 'Reviewed Member',
      description: 'A reviewed member skill.',
      procedure: 'This procedure should wait for bundle review.',
    });
    registry.markReviewed('reviewed-member');
    registry.createBundle({
      name: 'Unreviewed Pack',
      description: 'Unreviewed bundle should not activate members.',
      skillIds: ['reviewed-member'],
      enabled: true,
    });

    const prompt = buildEnabledSkillsPrompt(paths);

    expect(prompt).toContain('Suppressed Skills Pending Review Or Setup');
    expect(prompt).toContain('Unreviewed Pack: review=Needs review');
    expect(prompt).toContain('Reviewed Member:');
    expect(prompt).not.toContain('This procedure should wait for bundle review.');
  });

  test('removes deleted skills from bundles and drops empty bundles', () => {
    const { registry } = tempRegistry();
    registry.create({
      name: 'Only Skill',
      description: 'Single skill.',
      procedure: 'Do one thing clearly.',
    });
    registry.createBundle({
      name: 'Temporary Pack',
      description: 'Single-skill bundle.',
      skillIds: ['only-skill'],
      enabled: true,
    });

    registry.deleteSkill('only-skill');

    expect(registry.snapshot().skills).toHaveLength(0);
    expect(registry.snapshot().bundles).toHaveLength(0);
  });

  test('imports a skill from standard SKILL.md content with review-first policy', () => {
    const { registry } = tempRegistry();
    const content = '---\nname: Morning Brief\ndescription: Prepare a daily briefing.\nlicense: MIT\n---\nCheck calendar and tasks.\n';
    const skill = registry.importFromStandard(content);
    expect(skill.name).toBe('Morning Brief');
    expect(skill.description).toBe('Prepare a daily briefing.');
    expect(skill.procedure).toBe('Check calendar and tasks.');
    expect(skill.enabled).toBe(false);
    expect(skill.provenance).toBe('skill-standard-import');
    expect(skill.source).toBe('imported');
    expect(skill.reviewState).toBe('fresh');
  });

  test('importFromStandard rejects file missing required frontmatter', () => {
    const { registry } = tempRegistry();
    const content = '---\ndescription: No name.\n---\nBody.\n';
    expect(() => registry.importFromStandard(content)).toThrow('name');
  });

  test('importFromStandard rejects secret-looking content', () => {
    const { registry } = tempRegistry();
    const content = '---\nname: Bad Skill\ndescription: Invalid.\n---\npassword=hunter2-value\n';
    expect(() => registry.importFromStandard(content)).toThrow('secret');
  });

  test('exports a skill to standard SKILL.md format and round-trips', () => {
    const { registry } = tempRegistry();
    registry.create({
      name: 'Status Review',
      description: 'Review visible status.',
      procedure: 'Inspect health endpoint and report warnings.',
    });
    const tmpDir = makeProjectTempDir('goodvibes-agent-export');
    const written = registry.exportToStandard('status-review', tmpDir);
    expect(written).toBe(join(tmpDir, 'status-review', 'SKILL.md'));
    const content = readFileSync(written, 'utf-8');
    // import into a fresh registry to avoid duplicate-name collision
    const { registry: importRegistry } = tempRegistry();
    const reimported = importRegistry.importFromStandard(content);
    expect(reimported.name).toBe('Status Review');
    expect(reimported.description).toBe('Review visible status.');
  });

  test('exportToStandard throws for unknown skill id', () => {
    const { registry } = tempRegistry();
    const tmpDir = makeProjectTempDir('goodvibes-agent-export');
    expect(() => registry.exportToStandard('nonexistent', tmpDir)).toThrow('Unknown skill');
  });

  test('exportToStandard rejects overwrite without flag', () => {
    const { registry } = tempRegistry();
    registry.create({
      name: 'Status Review',
      description: 'Review visible status.',
      procedure: 'Inspect health endpoint.',
    });
    const tmpDir = makeProjectTempDir('goodvibes-agent-export');
    registry.exportToStandard('status-review', tmpDir);
    expect(() => registry.exportToStandard('status-review', tmpDir)).toThrow('already exists');
  });

  test('render + import creates skill matching original fields', () => {
    const { registry } = tempRegistry();
    const original = registry.create({
      name: 'Approval Review',
      description: 'Summarize pending approvals.',
      procedure: 'Use read-only approval routes first.',
    });
    const rendered = renderSkillStandardMarkdown(original);
    // import into a fresh registry to avoid duplicate-name collision
    const { registry: importRegistry } = tempRegistry();
    const imported = importRegistry.importFromStandard(rendered);
    expect(imported.name).toBe(original.name);
    expect(imported.description).toBe(original.description);
    expect(imported.procedure).toBe(original.procedure);
  });
});
