import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLanguageConfig, loadLanguageConfigs } from '../sdk/src/platform/intelligence/config.js';
import { logger } from '../sdk/src/platform/utils/logger.js';

let home: string;
let project: string;
let warnSpy: Mock<typeof logger.warn>;

function languagesDir(root: string): string {
  const dir = join(root, '.goodvibes', 'languages');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeLanguage(root: string, langId: string, body: unknown): void {
  writeFileSync(join(languagesDir(root), `${langId}.json`), typeof body === 'string' ? body : JSON.stringify(body), 'utf-8');
}

function roots() {
  return { homeDirectory: home, workingDirectory: project };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'gv-lang-home-'));
  project = mkdtempSync(join(tmpdir(), 'gv-lang-project-'));
  warnSpy = spyOn(logger, 'warn') as Mock<typeof logger.warn>;
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

describe('loadLanguageConfigs directory scan', () => {
  test('a user or project file for a language with no built-in default adds that language', () => {
    writeLanguage(home, 'zig', { lsp: { command: 'zls', args: [] }, treeSitter: 'zig' });
    writeLanguage(project, 'elixir', { formatter: { command: 'mix', args: ['format', '-'] } });

    const configs = loadLanguageConfigs(roots());

    expect(configs.get('zig')).toEqual({ lsp: { command: 'zls', args: [] }, treeSitter: 'zig' });
    expect(configs.get('elixir')).toEqual({ formatter: { command: 'mix', args: ['format', '-'] } });
    expect(getLanguageConfig('zig', roots())?.lsp?.command).toBe('zls');
    // Built-in defaults are still present.
    expect(configs.get('typescript')?.lsp?.command).toBe('typescript-language-server');
  });

  test('precedence is defaults < user < project, for new and built-in languages', () => {
    writeLanguage(home, 'zig', { lsp: { command: 'zls-user', args: [] }, treeSitter: 'zig' });
    writeLanguage(project, 'zig', { lsp: { command: 'zls-project', args: ['--x'] } });
    writeLanguage(home, 'python', { lsp: { command: 'pylsp', args: [] } });
    writeLanguage(project, 'python', { linter: { command: 'ruff', args: ['check'] } });

    const configs = loadLanguageConfigs(roots());

    expect(configs.get('zig')).toEqual({ lsp: { command: 'zls-project', args: ['--x'] }, treeSitter: 'zig' });
    expect(configs.get('python')).toEqual({
      lsp: { command: 'pylsp', args: [] },
      treeSitter: 'python',
      linter: { command: 'ruff', args: ['check'] },
    });
  });

  test('an invalid file is logged and skipped, leaving the lower layer in place', () => {
    writeLanguage(home, 'zig', { lsp: { command: 'zls', args: [] } });
    writeLanguage(project, 'zig', { lsp: { command: 'zls' } });
    writeLanguage(project, 'nim', { note: 'no usable fields' });
    writeLanguage(project, 'ocaml', '{ not json');
    writeLanguage(project, 'rust', { treeSitter: 42 });

    const configs = loadLanguageConfigs(roots());

    expect(configs.get('zig')).toEqual({ lsp: { command: 'zls', args: [] } });
    expect(configs.has('nim')).toBe(false);
    expect(configs.has('ocaml')).toBe(false);
    expect(configs.get('rust')?.treeSitter).toBe('rust');
    const messages = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(messages.filter((m) => m.includes('skipping invalid language config'))).toHaveLength(3);
    expect(messages.filter((m) => m.includes('failed to read language config'))).toHaveLength(1);
  });

  test('non-json files in the languages directory are ignored', () => {
    writeFileSync(join(languagesDir(project), 'README.md'), '# notes', 'utf-8');
    const configs = loadLanguageConfigs(roots());
    expect([...configs.keys()].sort()).toEqual(
      ['bash', 'css', 'go', 'html', 'javascript', 'json', 'python', 'rust', 'tsx', 'typescript'],
    );
  });
});
