import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.ts';
import { CONFIG_SCHEMA, DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.ts';
import { configKeyScope } from '../sdk/src/platform/config/config-ownership.ts';
import { ingestSettingsFile, screenSettingsForIngestion, SettingsIngestionRefusal } from '../sdk/src/platform/config/settings-ingestion.ts';
import { DEFAULT_THEME_NAME, SYSTEM_THEME_NAME, listBundledThemes } from '../sdk/src/platform/presentation/theme/index.ts';
import type { HookEvent } from '../sdk/src/platform/hooks/types.ts';

const THEMES = [
  'goodvibes', 'goodvibes-neon', 'catppuccin', 'tokyonight', 'dracula', 'nord', 'gruvbox',
  'one-dark', 'rosepine', 'solarized', 'github', 'system', 'vaporwave',
];
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gv-terminal-theme-'));
  roots.push(root);
  const configDir = join(root, 'config');
  const workingDir = join(root, 'workspace');
  const options = { configDir, workingDir, surfaceRoot: 'tui' };
  const global = join(configDir, 'settings.json');
  const project = join(workingDir, '.goodvibes', 'tui', 'settings.json');
  const open = (readOnly = false) => new ConfigManager({ ...options, readOnly });
  return { root, global, project, open };
}

function seed(file: string, value: unknown): string {
  const bytes = `${JSON.stringify(value, null, 3)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return bytes;
}

function read(file: string): string { return readFileSync(file, 'utf-8'); }

function observe(manager: ConfigManager) {
  const changes: Array<{ next: unknown; previous: unknown }> = [];
  const hooks: HookEvent[] = [];
  manager.subscribe('display.theme', (next, previous) => { changes.push({ next, previous }); });
  manager.attachHookDispatcher({ fire: async (event) => { hooks.push(event); return { ok: true }; } });
  return { changes, hooks };
}

describe('terminal palette schema', () => {
  test('exact pinned choices match the live registry, system and the retained alias', () => {
    const setting = CONFIG_SCHEMA.find((entry) => entry.key === 'display.theme')!;
    expect(setting.type).toBe('enum');
    expect(setting.default).toBe('goodvibes');
    expect(setting.enumValues).toEqual(THEMES);
    expect(setting.enumValues).toEqual([...listBundledThemes().map((entry) => entry.name), SYSTEM_THEME_NAME, 'vaporwave']);
    expect(DEFAULT_CONFIG.display.theme).toBe(DEFAULT_THEME_NAME);
    // Keep the reviewed credential-key description byte-identical.
    expect(setting.description).toBe('Color theme name, the color palette (e.g. vaporwave). Independent of display.themeMode, which controls light/dark appearance.');
    expect(configKeyScope('display.theme')).toBe('client');
    expect(configKeyScope('display.themeMode')).toBe('client');
  });

  test('fresh, unset, keyed reset and full reset use goodvibes without persisting a default', () => {
    const f = fixture();
    expect(f.open(true).get('display.theme')).toBe('goodvibes');
    expect(existsSync(f.global)).toBe(false);
    const manager = f.open();
    expect(manager.get('display.theme')).toBe('goodvibes');
    const unset = seed(f.global, { display: { themeMode: 'light' } });
    manager.load();
    expect(manager.get('display.theme')).toBe('goodvibes');
    expect(read(f.global)).toBe(unset);
    manager.set('display.theme', 'vaporwave');
    manager.reset('display.theme');
    expect(manager.get('display.theme')).toBe('goodvibes');
    expect(manager.get('display.themeMode')).toBe('light');
    expect(JSON.parse(read(f.global))).toEqual({ display: { themeMode: 'light' } });
    expect(f.open().get('display.theme')).toBe('goodvibes');
    manager.set('display.theme', 'nord');
    manager.reset();
    expect(manager.get('display.theme')).toBe('goodvibes');
    expect(JSON.parse(read(f.global))).toEqual({});
    expect(f.open().get('display.theme')).toBe('goodvibes');
  });

  test('palette persistence remains client-local and themeMode remains independent', () => {
    const f = fixture();
    const homeDir = join(f.root, 'home');
    const manager = new ConfigManager({ homeDir, surfaceRoot: 'tui' });
    manager.set('display.themeMode', 'light');
    manager.set('display.theme', 'vaporwave');
    expect(manager.get('display.themeMode')).toBe('light');
    expect(JSON.parse(read(manager.getConfigPath()))).toEqual({ display: { themeMode: 'light', theme: 'vaporwave' } });
    expect(existsSync(join(homeDir, '.goodvibes', 'daemon', 'settings.json'))).toBe(false);
    expect(existsSync(join(homeDir, '.goodvibes', 'shared', 'settings.json'))).toBe(false);
    expect(new ConfigManager({ homeDir, surfaceRoot: 'agent', readOnly: true }).get('display.theme')).toBe('goodvibes');
    manager.set('display.themeMode', 'dark');
    expect(manager.get('display.theme')).toBe('vaporwave');
  });
});

for (const scope of ['global', 'project'] as const) {
  describe(`${scope} terminal palette persistence`, () => {
    for (const theme of THEMES) {
      test(`${theme} sets, emits and reloads literally`, () => {
        const f = fixture();
        const baseline = seed(f.global, { display: { themeMode: 'light' }, provider: { systemPromptFile: 'unchanged' } });
        const manager = f.open();
        const { changes, hooks } = observe(manager);
        if (scope === 'project') manager.setProjectValue('display.theme', theme);
        else manager.set('display.theme', theme);
        expect(manager.get('display.theme')).toBe(theme);
        expect(manager.get('display.themeMode')).toBe('light');
        expect(changes).toEqual([{ next: theme, previous: 'goodvibes' }]);
        expect(hooks).toHaveLength(1);
        expect(hooks[0]?.payload).toEqual({ key: 'display.theme', value: theme, previousValue: 'goodvibes' });
        const bytes = read(f[scope]);
        expect(JSON.parse(bytes).display.theme).toBe(theme);
        if (scope === 'project') expect(read(f.global)).toBe(baseline);
        manager.load();
        expect(manager.get('display.theme')).toBe(theme);
        expect(f.open().get('display.theme')).toBe(theme);
        expect(read(f[scope])).toBe(bytes);
      });

      test(`${theme} saved case and whitespace is accepted only in the read view`, () => {
        const f = fixture();
        const saved = ` \t${theme.toUpperCase()}\n `;
        const bytes = seed(f[scope], { display: { theme: saved, themeMode: 'light' }, provider: { systemPromptFile: ' Kept AS SAVED ' } });
        for (const readOnly of [false, true]) {
          const manager = f.open(readOnly);
          expect(manager.get('display.theme')).toBe(theme);
          expect(manager.get('display.themeMode')).toBe('light');
          expect(manager.get('provider.systemPromptFile')).toBe(' Kept AS SAVED ');
          expect(manager.getIngestionQuarantine()).toEqual([]);
          manager.load();
          expect(manager.get('display.theme')).toBe(theme);
          expect(read(f[scope])).toBe(bytes);
          if (readOnly) expect(() => manager.set('display.theme', 'nord')).toThrow();
        }
      });
    }

    test('unknown and non-string saved names stay invalid, visible and unmodified', () => {
      for (const value of ['midnight', ' UNKNOWN ', '', ' ', 'dark', 12, true, null, [], {}]) {
        const f = fixture();
        if (scope === 'project') seed(f.global, { display: { theme: 'nord' } });
        const bytes = seed(f[scope], { display: { theme: value, themeMode: 'light' }, provider: { systemPromptFile: 'kept' } });
        for (const readOnly of [false, true]) {
          const manager = f.open(readOnly);
          expect(manager.get('display.theme')).toBe(scope === 'project' ? 'nord' : 'goodvibes');
          expect(manager.get('provider.systemPromptFile')).toBe('kept');
          expect(manager.get('display.themeMode')).toBe('light');
          const notices = manager.getIngestionQuarantine();
          expect(notices).toHaveLength(1);
          expect(notices[0]).toMatchObject({ file: f[scope], key: 'display.theme', action: 'skipped' });
          expect(notices[0]?.reason).toContain('expects one of');
          expect(notices[0]?.remedy).toContain('fix the value');
          expect(read(f[scope])).toBe(bytes);
        }
      }
    });

    test('an external saved palette edit is adapted on live reload and emitted once', async () => {
      const f = fixture();
      seed(f.global, { display: { theme: 'nord', themeMode: 'light' } });
      if (scope === 'project') seed(f.project, { display: { theme: 'dracula' } });
      const manager = f.open();
      const previous = manager.get('display.theme');
      const { changes, hooks } = observe(manager);
      const stop = manager.watchConfigFiles({ intervalMs: 10 });
      try {
        const bytes = seed(f[scope], { display: { theme: ' VaPoRwAvE ', themeMode: 'light' } });
        const deadline = Date.now() + 10_000;
        while (changes.length === 0 && Date.now() < deadline) await Bun.sleep(10);
        expect(manager.get('display.theme')).toBe('vaporwave');
        expect(manager.get('display.themeMode')).toBe('light');
        expect(changes).toEqual([{ next: 'vaporwave', previous }]);
        expect(hooks).toHaveLength(1);
        expect(hooks[0]?.payload).toEqual({ key: 'display.theme', value: 'vaporwave', previousValue: previous });
        expect(manager.getIngestionQuarantine()).toEqual([]);
        expect(read(f[scope])).toBe(bytes);
      } finally { stop(); }
    });

    test('invalid new writes leave live values, saved bytes, subscriptions and hooks unchanged', () => {
      const f = fixture();
      const globalBytes = seed(f.global, { display: { theme: 'nord', themeMode: 'light' } });
      const projectBytes = seed(f.project, { display: { theme: 'dracula' } });
      const manager = f.open();
      const { changes, hooks } = observe(manager);
      for (const value of ['midnight', ' NORD ', 'DRACULA', ' VAPORWAVE ', '', 'dark', 12, false, null, [], {}]) {
        expect(() => {
          if (scope === 'project') manager.setProjectValue('display.theme', value as never);
          else manager.setDynamic('display.theme', value);
        }).toThrow('Invalid value for display.theme');
        expect(manager.get('display.theme')).toBe('dracula');
        expect(manager.get('display.themeMode')).toBe('light');
        expect(read(f.global)).toBe(globalBytes);
        expect(read(f.project)).toBe(projectBytes);
        expect(changes).toEqual([]);
        expect(hooks).toEqual([]);
      }
    });
  });
}

describe('terminal palette load adapter boundary', () => {
  test('normalizes a copy after migrations, without changing another enum or saved input', () => {
    const raw = { display: { theme: ' VAPORWAVE ', themeMode: ' DARK ' }, provider: { systemPromptFile: ' Kept ' } };
    const before = structuredClone(raw);
    let migrationTheme: unknown;
    const result = ingestSettingsFile(raw, '/saved.json', {
      migrate: (input) => { migrationTheme = (input.display as Record<string, unknown>).theme; return input; },
      write: () => {},
    });
    expect(migrationTheme).toBe(' VAPORWAVE ');
    expect(raw).toEqual(before);
    expect(result.config.display).toEqual({ theme: 'vaporwave' });
    expect(result.config.provider).toEqual({ systemPromptFile: ' Kept ' });
    expect(result.notices.map((entry) => entry.key)).toEqual(['display.themeMode']);
  });

  test('does not turn an unknown spelling into a valid choice or suppress a safety refusal', () => {
    const result = screenSettingsForIngestion({ display: { theme: ' UNKNOWN ' } }, '/saved.json');
    expect(result.notices).toHaveLength(1);
    expect(result.notices[0]?.reason).toContain(' UNKNOWN ');
    expect(result.config.display).toBeUndefined();
    expect(() => ingestSettingsFile({ display: { theme: ' NORD ' }, permissions: { mode: ' PLAN ' } }, '/saved.json', { write: () => {} }))
      .toThrow(SettingsIngestionRefusal);
  });

  test('existing file-writing migrations see the saved spelling before the read adapter', () => {
    const f = fixture();
    seed(f.global, { display: { theme: ' NORD ' }, wrfc: { autoCommit: false } });
    const manager = f.open();
    expect(manager.get('display.theme')).toBe('nord');
    expect(manager.get('contract.autoCommit')).toBe(false);
    const persisted = JSON.parse(read(f.global));
    expect(persisted.display.theme).toBe(' NORD ');
    expect(persisted.contract.autoCommit).toBe(false);
    expect(persisted.wrfc).toBeUndefined();
  });

  test('a prior whole-config dump retains its explicit vaporwave palette when defaults are stripped', () => {
    const f = fixture();
    seed(f.global, { ...structuredClone(DEFAULT_CONFIG), display: { ...DEFAULT_CONFIG.display, theme: 'vaporwave' } });
    const manager = f.open();
    expect(manager.get('display.theme')).toBe('vaporwave');
    expect(JSON.parse(read(f.global)).display.theme).toBe('vaporwave');
    expect(f.open().get('display.theme')).toBe('vaporwave');
  });

  for (const scope of ['global', 'project'] as const) {
    test(`explicit ${scope} bulk save serializes the adapted view while reads and key writes preserve saved spelling`, () => {
      for (const [saved, canonical] of [[' NORD ', 'nord'], [' VaPoRwAvE ', 'vaporwave'], [' GOODVIBES ', 'goodvibes']] as const) {
        const f = fixture();
        const bytes = seed(f[scope], { display: { theme: saved, themeMode: 'light' } });
        const readOnly = f.open(true);
        expect(readOnly.get('display.theme')).toBe(canonical);
        expect(read(f[scope])).toBe(bytes);
        expect(() => scope === 'global' ? readOnly.save() : readOnly.saveProject()).toThrow();
        expect(read(f[scope])).toBe(bytes);

        const manager = f.open();
        expect(read(f[scope])).toBe(bytes);
        if (scope === 'global') manager.set('display.stream', false);
        else manager.setProjectValue('display.stream', false);
        expect(JSON.parse(read(f[scope])).display).toEqual({ theme: saved, themeMode: 'light', stream: false });
        expect(manager.get('display.theme')).toBe(canonical);

        if (scope === 'global') manager.save();
        else manager.saveProject();
        const persisted = JSON.parse(read(f[scope]));
        // Bulk saves already omit defaults; the legacy alias remains literal.
        expect(persisted.display.theme).toBe(canonical === 'goodvibes' ? undefined : canonical);
        const reloaded = f.open(true);
        expect(reloaded.get('display.theme')).toBe(canonical);
        expect(reloaded.get('display.themeMode')).toBe('light');
        expect(reloaded.get('display.stream')).toBe(false);
        expect(reloaded.getIngestionQuarantine()).toEqual([]);
      }
    });
  }

  test('unrelated later writes keep a saved alias spelling rather than persisting its adapted view', () => {
    const f = fixture();
    seed(f.global, { display: { theme: ' VaPoRwAvE ', themeMode: 'dark' } });
    const manager = f.open();
    expect(manager.get('display.theme')).toBe('vaporwave');
    manager.set('display.stream', false);
    expect(JSON.parse(read(f.global)).display).toEqual({ theme: ' VaPoRwAvE ', themeMode: 'dark', stream: false });
    expect(f.open().get('display.theme')).toBe('vaporwave');
  });
});
