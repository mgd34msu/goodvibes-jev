import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildProjectContextPrompt, discoverProjectContextFiles } from '../../agent/project-context-files.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempPaths() {
  const root = makeProjectTempDir('goodvibes-agent-project-context');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return createShellPathService({ workingDirectory: workspace, homeDirectory: home });
}

describe('project context files', () => {
  test('discovers workspace, subdirectory, Cursor, and Hermes SOUL context', () => {
    const paths = tempPaths();
    mkdirSync(join(paths.workingDirectory, '.git'), { recursive: true });
    mkdirSync(join(paths.workingDirectory, 'frontend', 'src'), { recursive: true });
    mkdirSync(join(paths.workingDirectory, '.cursor', 'rules'), { recursive: true });
    const hermesHome = join(paths.homeDirectory, 'hermes-home');
    mkdirSync(hermesHome, { recursive: true });

    const previousHermesHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = hermesHome;
    try {
      writeFileSync(join(hermesHome, 'SOUL.md'), 'Prefer direct operator tone.');
      writeFileSync(join(paths.workingDirectory, '.hermes.md'), 'Hermes project instructions.');
      writeFileSync(join(paths.workingDirectory, 'AGENTS.md'), 'Prefer visible project context.');
      writeFileSync(join(paths.workingDirectory, 'frontend', 'AGENTS.md'), 'Frontend instructions override root style locally.');
      writeFileSync(join(paths.workingDirectory, '.cursorrules'), 'Cursor root convention.');
      writeFileSync(join(paths.workingDirectory, '.cursor', 'rules', 'ui.mdc'), 'Cursor UI rule.');

      const snapshot = discoverProjectContextFiles(paths, { targetPath: 'frontend/src/App.ts' });
      expect(snapshot.progressiveTargetAware).toBe(true);
      expect(snapshot.files.map((file) => file.source)).toEqual(expect.arrayContaining([
        'HERMES_HOME/SOUL.md',
        '.hermes.md',
        'AGENTS.md',
        '.cursorrules',
        '.cursor/rules/*.mdc',
      ]));
      expect(snapshot.files.find((file) => file.path.endsWith(join('frontend', 'AGENTS.md')))?.scope).toBe('subdirectory');
      expect(snapshot.blocked).toHaveLength(0);

      const prompt = buildProjectContextPrompt(paths) ?? '';
      expect(prompt).toContain('Project Context Files');
      expect(prompt).toContain('Prefer visible project context.');
      expect(prompt).toContain('Hermes project instructions.');
      expect(prompt).toContain('explicit user instructions');
    } finally {
      if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = previousHermesHome;
    }
  });

  test('blocks secret-looking context files without loading their bodies', () => {
    const paths = tempPaths();
    writeFileSync(join(paths.workingDirectory, 'AGENTS.md'), 'Use safe visible instructions.');
    writeFileSync(join(paths.workingDirectory, 'CLAUDE.md'), 'token=super-secret-value\nNever reveal this text.');

    const snapshot = discoverProjectContextFiles(paths);
    expect(snapshot.files.map((file) => file.source)).toContain('AGENTS.md');
    expect(snapshot.blocked).toHaveLength(1);
    expect(snapshot.blocked[0]?.source).toBe('CLAUDE.md');
    expect(snapshot.blocked[0]?.reason).toContain('secret-looking');

    const prompt = buildProjectContextPrompt(paths) ?? '';
    expect(prompt).toContain('Blocked Project Context Files');
    expect(prompt).toContain('secret-looking');
    expect(prompt).not.toContain('Never reveal this text');
  });
});
