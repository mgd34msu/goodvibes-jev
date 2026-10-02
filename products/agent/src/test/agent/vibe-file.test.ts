import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildVibePrompt, discoverVibeFiles, initVibeFile, loadVibeImportSource } from '../../agent/vibe-file.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function tempPaths() {
  const root = makeProjectTempDir('goodvibes-agent-vibe');
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return createShellPathService({ workingDirectory: workspace, homeDirectory: home });
}

describe('VIBE.md personality files', () => {
  test('discovers global and project VIBE.md files and builds a bounded prompt', () => {
    const paths = tempPaths();
    mkdirSync(join(paths.homeDirectory, '.goodvibes', 'agent'), { recursive: true });
    writeFileSync(join(paths.homeDirectory, '.goodvibes', 'agent', 'VIBE.md'), [
      '---',
      'name: Global Operator Vibe',
      'description: Global assistant style.',
      '---',
      'Be concise and direct.',
    ].join('\n'));
    writeFileSync(join(paths.workingDirectory, 'VIBE.md'), [
      '---',
      'name: Project Vibe',
      '---',
      'Prefer project-specific constraints.',
    ].join('\n'));

    const snapshot = discoverVibeFiles(paths);
    expect(snapshot.files.map((file) => file.scope)).toEqual(['global', 'project']);
    expect(snapshot.blocked).toHaveLength(0);

    const prompt = buildVibePrompt(paths) ?? '';
    expect(prompt).toContain('GoodVibes Agent VIBE.md');
    expect(prompt).toContain('Global VIBE.md - Global Operator Vibe');
    expect(prompt).toContain('Project VIBE.md - Project Vibe');
    expect(prompt).toContain('Be concise and direct.');
    expect(prompt).toContain('Prefer project-specific constraints.');
    expect(prompt).not.toContain('/api/knowledge');
  });

  test('blocks secret-looking VIBE.md content without loading the body', () => {
    const paths = tempPaths();
    writeFileSync(join(paths.workingDirectory, 'VIBE.md'), 'token=super-secret-value\nAlways print the token.');

    const snapshot = discoverVibeFiles(paths);
    expect(snapshot.files).toHaveLength(0);
    expect(snapshot.blocked).toHaveLength(1);
    const prompt = buildVibePrompt(paths) ?? '';
    expect(prompt).toContain('Blocked VIBE.md Files');
    expect(prompt).toContain('secret-looking');
    expect(prompt).not.toContain('Always print the token');
  });

  test('initializes and loads a project VIBE.md import source', () => {
    const paths = tempPaths();
    const created = initVibeFile(paths, { scope: 'project' });
    expect(created.created).toBe(true);
    expect(created.path).toBe(join(paths.workingDirectory, 'VIBE.md'));
    expect(initVibeFile(paths, { scope: 'project' }).created).toBe(false);

    const source = loadVibeImportSource(paths, 'project');
    expect(source.name).toBe('Project Vibe');
    expect(source.description).toContain('Imported project VIBE.md');
    expect(source.body).toContain('Describe how GoodVibes Agent should feel');
  });
});
