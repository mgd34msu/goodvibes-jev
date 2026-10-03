import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { TuiConfigManager, TUI_NOTIFICATIONS_METADATA_ONLY_KEY as KEY, readTuiConfigValue, readTuiNotificationsMetadataOnly, subscribeTuiConfigValue } from '../../config/host-settings.ts';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerConfigCommand } from '../../input/commands/config.ts';
const roots: string[] = [];
afterEach(() => { for(const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'tui-host-consumers-')); roots.push(root);
 const workingDir = join(root, 'project'); mkdirSync(workingDir);
 const options = { homeDir: root, workingDir, configDir: join(root, 'config'), surfaceRoot: 'tui' };
 return { options, config: new TuiConfigManager(options) };
}

test('notification readers use registered live handle and stay restrictive for bare SDK raw false', () => {
 const { config, options } = fixture();
 expect(readTuiNotificationsMetadataOnly(config)).toBe(true);
 const handle = config.getHostBooleanSetting(KEY); handle.set(false);
 expect(readTuiConfigValue(config, KEY)).toBe(false);
 expect(readTuiNotificationsMetadataOnly(new ConfigManager(options))).toBe(true);
 rmSync(config.getConfigPath()); config.load();
 expect(readTuiConfigValue(config, KEY)).toBe(true);
 expect(readTuiConfigValue(config, 'permissions.mode')).toBe(config.get('permissions.mode'));
});

test('typed notification consent revokes on invalid reload and subscription has one owner', () => {
 const { config } = fixture(); const observed: unknown[][] = [];
 const unsub = subscribeTuiConfigValue(config, KEY, (...values) => observed.push(values));
 config.getHostBooleanSetting(KEY).set(false);
 expect(observed).toEqual([[false, true]]);
 writeFileSync(config.getConfigPath(), '{'); expect(() => config.load()).toThrow();
 expect(readTuiNotificationsMetadataOnly(config)).toBe(true);
 expect(observed).toEqual([[false, true], [true, false]]); unsub();
 config.getHostBooleanSetting(KEY).set(false); expect(observed).toHaveLength(2);
});

function command(config: ConfigManager) {
 const messages: string[] = []; const registry = new CommandRegistry(); registerConfigCommand(registry);
 const ctx = { platform: { configManager: config }, print: (text: string) => messages.push(text), renderRequest: () => {} } as unknown as CommandContext;
 return { messages, run: (value: string) => registry.execute('config', ['set', KEY, value], ctx) };
}

test('ordinary config command writes through validated host handle and respects current project tier', async () => {
 const { config } = fixture(); const handle = config.getHostBooleanSetting(KEY);
 handle.set(false); handle.setProjectValue(true);
 const c = command(config); await c.run('false');
 expect(handle.get()).toBe(false); expect(c.messages.at(-1)).toContain('true → false');
 await c.run('true'); expect(handle.get()).toBe(true);
 expect(JSON.parse(readFileSync(config.getConfigPath(), 'utf8')).behavior.notificationsMetadataOnly).toBe(false);
 expect(JSON.parse(readFileSync(config.getProjectConfigPath()!, 'utf8')).behavior.notificationsMetadataOnly).toBe(true);
 for(const value of ['0', '1', 'FALSE', '"false"', 'null']) { await c.run(value); expect(c.messages.at(-1)).toContain('literal boolean'); expect(handle.get()).toBe(true); }
});

test('unregistered manager refuses host command rather than using builtin or dynamic write', async () => {
 const { options } = fixture(); const config = new ConfigManager(options); const c = command(config);
 await c.run('false'); expect(c.messages.at(-1)).toContain('Could not set'); expect(readTuiNotificationsMetadataOnly(config)).toBe(true);
});


test('host CLI refuses unreadable metadata without quarantining the policy or writing consent', async () => {
 const { config, options } = fixture(); const handle = config.getHostBooleanSetting(KEY); handle.set(true);
 const policy = join(options.configDir, 'settings-sync.json'); writeFileSync(policy, '{');
 const c = command(config); const before = readFileSync(config.getConfigPath(), 'utf8');
 await c.run('false'); expect(c.messages.at(-1)).toContain('metadata is unavailable');
 expect(readFileSync(policy, 'utf8')).toBe('{'); expect(readFileSync(config.getConfigPath(), 'utf8')).toBe(before);
 expect(readdirSync(options.configDir).some(name => name.startsWith('settings-sync.json.'))).toBe(false);
 expect(handle.get()).toBe(true);
});
