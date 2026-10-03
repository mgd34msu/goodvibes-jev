import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DiscoveredServer } from '@goodvibes-jev/engine/sdk/platform/discovery';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerDiscoveryRuntimeCommands } from '../../input/commands/discovery-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

describe('explicit /scan', () => {
  test('does not scan when registered, then scans, registers, and persists on request', async () => {
    const home = makeProjectTempDir('explicit-provider-scan-');
    const server: DiscoveredServer = {
      name: 'Requested model server', host: '192.0.2.42', port: 11434,
      baseURL: 'http://192.0.2.42:11434/v1', models: ['fixture-model'], serverType: 'ollama',
    };
    let scans = 0;
    const registry = new CommandRegistry();
    registerDiscoveryRuntimeCommands(registry, async () => {
      scans++;
      return { servers: [server], scannedHosts: 255, scannedPorts: 11, durationMs: 100 };
    });
    expect(scans).toBe(0);
    const registered: DiscoveredServer[][] = [];
    const printed: string[] = [];
    let renders = 0;
    const ctx = {
      clients: { providerApi: { registerDiscoveredProviders: async (servers: DiscoveredServer[]) => { registered.push(servers); } } },
      workspace: { shellPaths: { homeDirectory: home, workingDirectory: home } },
      print: (text: string) => { printed.push(text); },
      renderRequest: () => { renders++; },
    } as unknown as CommandContext;
    await registry.execute('scan', [], ctx);
    expect(scans).toBe(1);
    expect(registered).toEqual([[server]]);
    expect(printed.join('\n')).toContain('Found 1 server(s)');
    expect(printed.join('\n')).toContain('192.0.2.42:11434');
    expect(renders).toBe(2);
    expect(JSON.parse(readFileSync(join(home, '.goodvibes', 'tui', 'discovered-providers.json'), 'utf8'))).toEqual([
      { ...server, lastSeen: expect.any(Number) },
    ]);
  });
});
