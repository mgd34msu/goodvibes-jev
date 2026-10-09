import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { prepareDaemonCliServe } from '../../cli/serve.ts';
import { parseDaemonCli } from '../../cli/parser.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const configDir = mkdtempSync(join(tmpdir(), 'runtime-cli-')); roots.push(configDir);
  writeFileSync(join(configDir, 'settings.json'), JSON.stringify({ provider: { model: 'synthetic:disk' } }));
  return new ConfigManager({ configDir });
}

test('actual daemon serve preparation preserves resolved provider/model and endpoint flags across reload', () => {
  const config = fixture();
  const parsed = parseDaemonCli(['serve', '--config', 'provider.model=synthetic:generic', '--provider', 'openai', '--model', 'anthropic:fixture-model', '--hostname', 'daemon.example.test', '--port', '4310']);
  expect(parsed.errors).toEqual([]); expect(prepareDaemonCliServe(config, parsed.flags)).toEqual([]);
  config.load(); config.save(); config.load();
  expect(config.get('provider.model')).toBe('openai:fixture-model');
  expect(config.get('controlPlane.host')).toBe('daemon.example.test'); expect(config.get('controlPlane.port')).toBe(4310);
  expect(readFileSync(config.getConfigPath(), 'utf8')).not.toContain('fixture-model');
});
