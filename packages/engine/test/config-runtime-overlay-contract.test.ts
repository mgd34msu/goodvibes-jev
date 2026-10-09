import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import { DEFAULT_CONFIG } from '../sdk/src/platform/config/schema.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function write(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value));
}
function fixture(globalFile = false, readOnly = false) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-overlay-contract-')); roots.push(root);
  const configDir = join(root, 'config'); const workingDir = join(root, 'project'); mkdirSync(workingDir);
  if (globalFile) write(join(configDir, 'settings.json'), { provider: { model: 'synthetic:disk-model' } });
  const manager = new ConfigManager({ configDir, homeDir: join(root, 'home'), workingDir, surfaceRoot: 'tui', ownsDaemonTier: true, readOnly });
  return { root, manager };
}

describe('explicit runtime overlay contract', () => {
  test.each([false, true])('invocation values survive accepted reloads and file removal, global initially present %#', (globalFile) => {
    const { manager } = fixture(globalFile);
    manager.setRuntimeOverride('provider.model', 'synthetic:invocation');
    manager.setRuntimeOverride('permissions.mode', 'plan');
    write(manager.getSharedTierPath()!, { tts: { voice: 'synthetic-shared' } }); manager.load(); manager.load();
    expect(manager.get('provider.model')).toBe('synthetic:invocation');
    expect(manager.get('permissions.mode')).toBe('plan');
    if (existsSync(manager.getConfigPath())) rmSync(manager.getConfigPath());
    manager.load();
    expect(manager.get('provider.model')).toBe('synthetic:invocation');
    expect(manager.get('permissions.mode')).toBe('plan');
  });

  test('defaults stay below explicit invocation values regardless of registration order', () => {
    const { manager } = fixture();
    manager.setRuntimeOverride('display.showTokenSpeed', false);
    manager.setRuntimeDefault('display.showTokenSpeed', true); manager.load();
    expect(manager.get('display.showTokenSpeed')).toBe(false);
  });

  test('new persisted values beat frontend defaults, including values equal to shipped defaults', () => {
    const { manager } = fixture();
    expect(DEFAULT_CONFIG.display.showTokenSpeed).toBe(false);
    manager.setRuntimeDefault('display.showTokenSpeed', true);
    expect(manager.get('display.showTokenSpeed')).toBe(true);
    write(manager.getConfigPath(), { display: { showTokenSpeed: false } }); manager.load();
    expect(manager.get('display.showTokenSpeed')).toBe(false);
    manager.save(); manager.load();
    expect(manager.get('display.showTokenSpeed')).toBe(false);
    const persisted = JSON.parse(readFileSync(manager.getConfigPath(), 'utf8')) as { display?: { showTokenSpeed?: boolean } };
    expect(persisted.display?.showTokenSpeed).toBe(false);
    write(manager.getConfigPath(), {}); manager.load();
    expect(manager.get('display.showTokenSpeed')).toBe(true);
  });

  test.each(['set', 'project', 'category', 'reset', 'remove'] as const)('successful %s supersedes only the touched invocation value', (kind) => {
    const { manager } = fixture(true);
    manager.setRuntimeOverride('provider.model', 'synthetic:invocation');
    manager.setRuntimeOverride('permissions.mode', 'plan');
    if (kind === 'set') manager.set('provider.model', 'synthetic:chosen');
    if (kind === 'project') manager.setProjectValue('provider.model', 'synthetic:chosen');
    if (kind === 'category') manager.mergeCategory('provider', { model: 'synthetic:chosen' });
    if (kind === 'reset') manager.reset('provider.model');
    if (kind === 'remove') manager.removeCategoryKey('provider', 'model');
    manager.load(); manager.load();
    expect(manager.get('provider.model')).toBe(kind === 'reset' || kind === 'remove' ? DEFAULT_CONFIG.provider.model : 'synthetic:chosen');
    expect(manager.get('permissions.mode')).toBe('plan');
  });

  test('full reset retires invocation authority while keeping registered frontend defaults', () => {
    const { manager } = fixture();
    manager.setRuntimeDefault('display.showTokenSpeed', true);
    manager.setRuntimeOverride('display.showTokenSpeed', false);
    manager.setRuntimeOverride('provider.model', 'synthetic:invocation');
    manager.reset(); manager.load();
    expect(manager.get('display.showTokenSpeed')).toBe(true);
    expect(manager.get('provider.model')).toBe(DEFAULT_CONFIG.provider.model);
  });

  test('daemon batch supersedes its invocation entries without revoking unrelated entries', () => {
    const { manager } = fixture();
    manager.setRuntimeOverride('surfaces.email.host', 'invocation.example.test');
    manager.setRuntimeOverride('permissions.mode', 'plan');
    manager.setDaemonValues({ 'surfaces.email.host': 'persisted.example.test' }); manager.load();
    expect(manager.get('surfaces.email.host')).toBe('persisted.example.test');
    expect(manager.get('permissions.mode')).toBe('plan');
  });

  test.each(['global', 'project'] as const)('bulk %s save does not persist or retire temporary values', (destination) => {
    const { manager } = fixture(true);
    manager.setRuntimeOverride('provider.model', 'synthetic:never-persist');
    manager.setRuntimeDefault('display.showTokenSpeed', true);
    if (destination === 'global') manager.save(); else manager.saveProject();
    const file = destination === 'global' ? manager.getConfigPath() : manager.getProjectConfigPath()!;
    const bytes = readFileSync(file, 'utf8');
    expect(bytes).not.toContain('synthetic:never-persist');
    expect(bytes).not.toContain('showTokenSpeed');
    expect(bytes).toContain('synthetic:disk-model');
    manager.load();
    expect(manager.get('provider.model')).toBe('synthetic:never-persist');
    expect(manager.get('display.showTokenSpeed')).toBe(true);
  });

  test('read-only preview accepts runtime values without any filesystem changes', () => {
    const { root, manager } = fixture(false, true);
    const before = readdirSync(root, { recursive: true }).sort();
    manager.setRuntimeOverride('controlPlane.publicBaseUrl', 'https://preview.example.test');
    manager.setRuntimeDefault('display.showTokenSpeed', true); manager.load();
    expect(manager.get('controlPlane.publicBaseUrl')).toBe('https://preview.example.test');
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    expect(() => manager.save()).toThrow();
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
  });

  test.each(['locked', 'unreadable'] as const)('%s managed policy refuses admission without repair or value disclosure', (policy) => {
    const { root, manager } = fixture();
    const path = join(dirname(manager.getConfigPath()), 'settings-sync.json');
    write(path, { version: 2, managedLocks: [{ key: 'provider.model', source: 'synthetic', reason: 'locked', updatedAt: 1 }] });
    if (policy === 'unreadable') writeFileSync(path, '{invalid policy');
    const before = readFileSync(path, 'utf8'); const files = readdirSync(root, { recursive: true }).sort();
    let error: unknown;
    try { manager.setRuntimeOverride('provider.model', 'synthetic-sensitive-marker'); } catch (caught) { error = caught; }
    expect(error).toBeDefined(); expect(String(error)).not.toContain('synthetic-sensitive-marker');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(files);
  });

  test('structured invocation input and borrowed reads cannot mutate the stored overlay', () => {
    const { manager } = fixture();
    const prices = { 'synthetic:model': { input: 1, output: 2 } };
    manager.setRuntimeOverride('pricing.modelPrices', prices);
    prices['synthetic:model'].input = 100;
    expect(manager.get('pricing.modelPrices')['synthetic:model']?.input).toBe(1);
    const borrowed = manager.get('pricing.modelPrices');
    try { Reflect.set(borrowed['synthetic:model']!, 'input', 200); } catch { /* freezing is also valid isolation */ }
    expect(manager.get('pricing.modelPrices')['synthetic:model']?.input).toBe(1);
    manager.load();
    expect(manager.get('pricing.modelPrices')['synthetic:model']?.input).toBe(1);
  });

  test('failed persisted writes and reloads retain active authority but advance incarnation', () => {
    const { manager } = fixture(true);
    manager.setRuntimeOverride('provider.model', 'synthetic:invocation');
    manager.setRuntimeOverride('permissions.mode', 'plan');
    const incarnation = manager.getAutonomousPermissionSnapshot().incarnation;
    expect(() => manager.set('permissions.mode', 'invalid-mode' as never)).toThrow();
    write(manager.getDaemonTierPath()!, { permissions: { mode: 'invalid-mode' } });
    expect(() => manager.load()).toThrow();
    expect(manager.get('provider.model')).toBe('synthetic:invocation');
    expect(manager.get('permissions.mode')).toBe('plan');
    expect(manager.getAutonomousPermissionSnapshot().incarnation).toBeGreaterThan(incarnation);
  });
});
