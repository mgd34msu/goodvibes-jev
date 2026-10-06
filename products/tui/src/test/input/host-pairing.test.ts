import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { registerHostPairingCommands } from '../../input/commands/host-pairing.ts';
import { createShellPathService } from '../../runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

for (const args of [['pair'], ['pair', '--apply'], ['pair', '--bootstrap-shared', '--apply'], ['pair', '--yes']]) test(`generic slash dispatch has no pairing capability: ${args.join(' ')}`, async () => {
  const home = makeProjectTempDir('slash-host-pair'); const lines: string[] = [];
  const registry = new CommandRegistry(); registerHostPairingCommands(registry);
  const configManager = { get: (key: string) => key === 'daemon.enabled' ? true : key === 'controlPlane.publicBaseUrl' ? 'http://127.0.0.1:1' : undefined } as unknown as ConfigManager;
  const context = { print: (line: string) => lines.push(line), platform: { configManager }, workspace: { shellPaths: createShellPathService({ homeDirectory: home, workingDirectory: home }) }, ownerConfirmed: true } as unknown as CommandContext;
  await registry.execute('host', args, context);
  expect(lines.join('\n')).toContain('owner terminal'); expect(lines.join('\n')).not.toContain('PAIR '); expect(existsSync(join(home, '.goodvibes'))).toBe(false);
});
