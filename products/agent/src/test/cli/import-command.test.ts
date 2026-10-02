import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { scanOpenClawWorkspace } from '../../cli/openclaw-import.ts';
import { AgentPersonaRegistry } from '../../agent/persona-registry.ts';
import { AgentSkillRegistry } from '../../agent/skill-registry.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const FIXTURE = join(import.meta.dir, '..', 'fixtures', 'openclaw-workspace');
const roots: string[] = [];

async function runCli(args: readonly string[], home: string): Promise<{ readonly exitCode: number; readonly output: string }> {
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: home, homeDir: home, surfaceRoot: 'agent' }),
      workingDirectory: home,
      homeDirectory: home,
    });
    return { exitCode: result.exitCode, output: output.join('\n') };
  } finally {
    console.log = originalLog;
  }
}

function freshHome(): string {
  const home = makeProjectTempDir('goodvibes-agent-import-cli');
  roots.push(home);
  return home;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('goodvibes-agent import openclaw', () => {
  test('command alias parses', () => {
    expect(parseGoodVibesCli(['import', 'openclaw']).command).toBe('import');
    expect(parseGoodVibesCli(['migrate', 'openclaw']).command).toBe('import');
  });

  test('scanner maps the fixture workspace into a stable plan', () => {
    const plan = scanOpenClawWorkspace(FIXTURE);
    expect(plan.exists).toBe(true);

    // Personas: CLAUDE.md + AGENTS.md; notes.md is not a recognized instruction file.
    expect(plan.personas.map((p) => p.name).sort()).toEqual(['AGENTS', 'Ops Copilot']);

    // Memory: two bullets from memory.md + one from preferences.md; bad-class.md skipped.
    expect(plan.memories).toHaveLength(3);
    expect(plan.memories.map((m) => `${m.scope}/${m.cls}`).sort()).toEqual([
      'project/decision',
      'project/fact',
      'project/fact',
    ]);

    // Skills: daily-brief.md + skills/ops/SKILL.md.
    expect(plan.skills.map((s) => s.name).sort()).toEqual(['Daily Brief', 'Ops Sweep']);
    const dailyBrief = plan.skills.find((s) => s.name === 'Daily Brief');
    expect(dailyBrief?.requiresEnv).toEqual(['OPENCLAW_TOKEN']);
    expect(dailyBrief?.requiresCommand).toEqual(['gh']);

    // Permissions: read, write, exec (Bash), find (search); teleport unmapped.
    expect(plan.permissions.categories).toEqual(['exec', 'find', 'read', 'write']);

    // Skip reasons are explicit, never guessed.
    const reasons = plan.skipped.map((s) => s.reason);
    expect(reasons.some((r) => r.includes('not a recognized instruction file'))).toBe(true);
    expect(reasons.some((r) => r.includes('unknown memory class'))).toBe(true);
    expect(reasons.some((r) => r.includes('no SKILL.md'))).toBe(true);
    expect(reasons.some((r) => r.includes('teleport') && r.includes('known Agent tool category'))).toBe(true);
  });

  test('dry-run is the default and writes nothing', async () => {
    const home = freshHome();
    const result = await runCli(['import', 'openclaw', FIXTURE], home);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('OpenClaw import (dry run)');
    expect(result.output).toContain('personas: 2');
    expect(result.output).toContain('memory records: 3');
    expect(result.output).toContain('skills: 2');
    expect(result.output).toContain('allow: exec, find, read, write');
    expect(result.output).toContain('Re-run with --apply');

    // Nothing was written to the registries.
    expect(AgentPersonaRegistry.fromShellPaths({ resolveUserPath: (...parts) => join(home, '.goodvibes', ...parts) }).list()).toHaveLength(0);
  });

  test('--apply writes through the persona and skill registries and permission settings', async () => {
    const home = freshHome();
    const configManager = new ConfigManager({ workingDir: home, homeDir: home, surfaceRoot: 'agent' });
    const output: string[] = [];
    const originalLog = console.log;
    try {
      console.log = (value?: unknown) => { output.push(String(value)); };
      const result = await handleGoodVibesCliCommand({
        cli: parseGoodVibesCli(['import', 'openclaw', FIXTURE, '--apply']),
        configManager,
        workingDirectory: home,
        homeDirectory: home,
      });
      expect(result.exitCode).toBe(0);
    } finally {
      console.log = originalLog;
    }
    const text = output.join('\n');
    expect(text).toContain('OpenClaw import (applied)');
    expect(text).toContain('personas created 2');
    expect(text).toContain('memory records created 3');
    expect(text).toContain('skills created 2');
    expect(text).toContain('permission categories allowed 4');

    const resolveUserPath = (...parts: string[]) => join(home, '.goodvibes', ...parts);
    const personas = AgentPersonaRegistry.fromShellPaths({ resolveUserPath }).list();
    expect(personas.map((p) => p.name).sort()).toEqual(['AGENTS', 'Ops Copilot']);
    expect(personas.every((p) => p.source === 'imported')).toBe(true);

    const skills = AgentSkillRegistry.fromShellPaths({ resolveUserPath }).snapshot().skills;
    expect(skills.map((s) => s.name).sort()).toEqual(['Daily Brief', 'Ops Sweep']);

    expect(configManager.get('permissions.mode')).toBe('custom');
    expect(String(configManager.get('permissions.tools.exec' as never))).toBe('allow');
    expect(String(configManager.get('permissions.tools.read' as never))).toBe('allow');
  });

  test('missing default workspace reports plainly', async () => {
    const home = freshHome();
    const result = await runCli(['import', 'openclaw', join(home, 'does-not-exist')], home);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('OpenClaw workspace not found');
  });

  test('unknown import source is rejected', async () => {
    const home = freshHome();
    const result = await runCli(['import', 'wharfware'], home);
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Unknown import source');
  });
});
